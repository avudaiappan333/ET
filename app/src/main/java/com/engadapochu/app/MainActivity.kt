package com.engadapochu.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.room.*
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.util.Locale

@Entity(tableName = "transactions", indices = [Index(value = ["type", "amountMinor", "personName", "transactionTime"])])
data class MoneyTransaction(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val type: String,
    val amountMinor: Long,
    val currency: String = "INR",
    val personName: String = "",
    val category: String = "",
    val note: String = "",
    val transactionDate: String,
    val transactionTime: Long,
    val source: String,
    val originalVoiceText: String? = null,
    val createdAt: Long = System.currentTimeMillis(),
    val updatedAt: Long = System.currentTimeMillis(),
    val deletedAt: Long? = null,
    val isDeleted: Boolean = false,
    val syncStatus: String = "LOCAL_ONLY"
)

@Dao
interface TransactionDao {
    @Query("SELECT * FROM transactions WHERE isDeleted = 0 ORDER BY transactionDate DESC, transactionTime DESC")
    fun observeAll(): Flow<List<MoneyTransaction>>
    @Query("SELECT * FROM transactions WHERE isDeleted = 0 ORDER BY transactionDate DESC, transactionTime DESC")
    suspend fun getAll(): List<MoneyTransaction>
    @Insert suspend fun insert(tx: MoneyTransaction): Long
    @Update suspend fun update(tx: MoneyTransaction)
    @Query("UPDATE transactions SET isDeleted = 1, deletedAt = :time, updatedAt = :time WHERE id = :id") suspend fun softDelete(id: Long, time: Long = System.currentTimeMillis())
    @Query("UPDATE transactions SET isDeleted = 0, deletedAt = NULL, updatedAt = :time WHERE id = :id") suspend fun undoDelete(id: Long, time: Long = System.currentTimeMillis())
    @Query("SELECT * FROM transactions WHERE isDeleted = 0 AND type = :type") suspend fun byType(type: String): List<MoneyTransaction>
}

@Database(entities = [MoneyTransaction::class], version = 1, exportSchema = false)
abstract class MoneyDatabase : RoomDatabase() {
    abstract fun transactions(): TransactionDao
    companion object {
        @Volatile private var instance: MoneyDatabase? = null
        fun get(context: android.content.Context): MoneyDatabase = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(context.applicationContext, MoneyDatabase::class.java, "engada-local.db").build().also { instance = it }
        }
    }
}

data class ParsedEntry(val type: String, val amountMinor: Long, val person: String, val category: String = "", val original: String)
object VoiceParser {
    private val amountRegex = Regex("(?:₹\\s*)?([0-9]+(?:,[0-9]{3})*(?:\\.[0-9]{1,2})?)")
    fun parse(input: String): Result<ParsedEntry> {
        val normalized = input.trim().lowercase(Locale.ROOT).replace(Regex("\\s+"), " ")
        if (normalized.isBlank()) return Result.failure(IllegalArgumentException("Enter an amount and command."))
        val matches = amountRegex.findAll(normalized).toList()
        if (matches.size != 1) return Result.failure(IllegalArgumentException(if (matches.isEmpty()) "Amount is missing." else "Use one amount per entry."))
        val amount = matches.single().groupValues[1].replace(",", "").toBigDecimalOrNull()
            ?: return Result.failure(IllegalArgumentException("Amount is invalid."))
        val minor = try { amount.movePointRight(2).longValueExact() } catch (_: Exception) { return Result.failure(IllegalArgumentException("Amount is too large or has too many decimals.")) }
        if (minor <= 0L) return Result.failure(IllegalArgumentException("Amount must be greater than zero."))
        val rules = listOf(
            "RECEIVED" to Regex("\\b(received|got|collected|vanginen|vaanginen)\\b"),
            "REFUND" to Regex("\\b(refund|returned|thiruppi)\\b"),
            "EXPENSE" to Regex("\\b(paid|spent|spend|expense|groceries|selavu)\\b"),
            "LENT" to Regex("\\b(lent|loaned|kuduthen|koduthen)\\b"),
            "BORROWED" to Regex("\\b(borrowed|borrow)\\b"),
            "SENT" to Regex("\\b(sent|send|gave|transferred|anuppinen)\\b")
        )
        val found = rules.filter { it.second.containsMatchIn(normalized) }.map { it.first }.distinct()
        if (found.size != 1) return Result.failure(IllegalArgumentException(if (found.isEmpty()) "Transaction type is unclear." else "Transaction type is ambiguous."))
        val type = found.single()
        val amountMatch = matches.single()
        val tail = normalized.removeRange(amountMatch.range).replace(Regex("\\b(sent|send|gave|transferred|received|got|collected|paid|spent|spend|expense|lent|loaned|borrowed|borrow|refund|returned|to|from|for|ku|kku|kitta|anuppinen|vanginen|vaanginen|kuduthen|koduthen|thiruppi)\\b"), " ").replace(Regex("\\s+"), " ").trim(' ', '.', ',', '?')
        val person = when {
            type == "EXPENSE" -> ""
            tail.isBlank() -> return Result.failure(IllegalArgumentException("Person is missing."))
            else -> tail.replaceFirstChar { if (it.isLowerCase()) it.titlecase(Locale.ROOT) else it.toString() }
        }
        val category = if (type == "EXPENSE") tail.replaceFirstChar { it.titlecase(Locale.ROOT) } else ""
        return Result.success(ParsedEntry(type, minor, person, category, input))
    }
}

class TransactionRepository(private val dao: TransactionDao) {
    val transactions = dao.observeAll()
    suspend fun insert(tx: MoneyTransaction) = dao.insert(tx)
    suspend fun update(tx: MoneyTransaction) = dao.update(tx)
    suspend fun delete(id: Long) = dao.softDelete(id)
    suspend fun undo(id: Long) = dao.undoDelete(id)
    suspend fun all() = dao.getAll()
}

class MoneyViewModel(private val repository: TransactionRepository) : ViewModel() {
    val transactions = repository.transactions.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())
    fun save(tx: MoneyTransaction, done: (Long) -> Unit = {}) = viewModelScope.launch { done(repository.insert(tx)) }
    fun delete(id: Long) = viewModelScope.launch { repository.delete(id) }
    fun undo(id: Long) = viewModelScope.launch { repository.undo(id) }
    fun update(tx: MoneyTransaction) = viewModelScope.launch { repository.update(tx.copy(updatedAt = System.currentTimeMillis())) }
    suspend fun exportRows() = repository.all()
}

class MainActivity : ComponentActivity() {
    private var recognizer: SpeechRecognizer? = null
    private var speechText by mutableStateOf("")
    private var speechError by mutableStateOf("")
    private val micPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { allowed ->
        if (allowed) startRecognition() else speechError = "Microphone permission was denied. You can still enter transactions manually."
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val dao = MoneyDatabase.get(this).transactions()
        val vm = ViewModelProvider(this, object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST") override fun <T : ViewModel> create(modelClass: Class<T>): T = MoneyViewModel(TransactionRepository(dao)) as T
        })[MoneyViewModel::class.java]
        setContent { MaterialTheme { MainScreen(vm, speechText, speechError, { requestVoice() }, { speechText = it }, { speechError = it }) } }
    }
    private fun requestVoice() {
        if (!SpeechRecognizer.isRecognitionAvailable(this)) { speechError = "Speech recognition is unavailable on this device. Use manual entry."; return }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            micPermission.launch(Manifest.permission.RECORD_AUDIO); return
        }
        startRecognition()
    }
    private fun startRecognition() {
        recognizer?.destroy()
        try {
            recognizer = SpeechRecognizer.createSpeechRecognizer(this).also { sr ->
                sr.setRecognitionListener(object : RecognitionListener {
                    override fun onReadyForSpeech(params: Bundle?) { speechError = "Listening…" }
                    override fun onBeginningOfSpeech() { speechError = "Listening…" }
                    override fun onRmsChanged(rmsdB: Float) {}
                    override fun onBufferReceived(buffer: ByteArray?) {}
                    override fun onEndOfSpeech() { speechError = "Understanding your entry…" }
                    override fun onError(error: Int) { speechError = "Could not recognize speech (error $error). Try again or type instead." }
                    override fun onResults(results: Bundle?) {
                        speechText = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
                        speechError = if (speechText.isBlank()) "No speech was recognized. Please retry or type." else "Review the recognized text before saving."
                    }
                    override fun onPartialResults(partialResults: Bundle?) {}
                    override fun onEvent(eventType: Int, params: Bundle?) {}
                })
                val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE, "en-IN")
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, "en-IN")
                }
                sr.startListening(intent)
            }
        } catch (_: Exception) { speechError = "Voice input could not start. Type your entry instead." }
    }
    override fun onStop() { recognizer?.cancel(); super.onStop() }
    override fun onDestroy() { recognizer?.destroy(); recognizer = null; super.onDestroy() }
}

@Composable
private fun MainScreen(vm: MoneyViewModel, recognized: String, speechError: String, onListen: () -> Unit, onRecognizedChange: (String) -> Unit, onError: (String) -> Unit) {
    val txs by vm.transactions.collectAsStateWithLifecycle()
    var command by remember { mutableStateOf("") }; var type by remember { mutableStateOf("SENT") }; var amount by remember { mutableStateOf("") }; var person by remember { mutableStateOf("") }; var category by remember { mutableStateOf("") }; var note by remember { mutableStateOf("") }; var query by remember { mutableStateOf("") }; var error by remember { mutableStateOf("") }; var pending by remember { mutableStateOf<MoneyTransaction?>(null) }; var undoId by remember { mutableLongStateOf(0L) }
    val today = LocalDate.now().toString()
    val visible = txs.filter { listOf(it.personName, it.note, it.category, it.type).any { s -> s.contains(query, ignoreCase = true) } }
    val sent = txs.filter { it.type == "SENT" || it.type == "LENT" }.sumOf { it.amountMinor }
    val received = txs.filter { it.type == "RECEIVED" || it.type == "REFUND" }.sumOf { it.amountMinor }
    val expenses = txs.filter { it.type == "EXPENSE" }.sumOf { it.amountMinor }
    fun review(source: String, original: String? = null) {
        try {
            val minor = amount.trim().toBigDecimal().movePointRight(2).longValueExact()
            require(minor > 0) { "Amount must be greater than zero." }
            if (type != "EXPENSE") require(person.isNotBlank()) { "Enter the person’s name." }
            pending = MoneyTransaction(type = type, amountMinor = minor, personName = person.trim(), category = category.trim(), note = note.trim(), transactionDate = today, transactionTime = System.currentTimeMillis(), source = source, originalVoiceText = original)
            error = ""
        } catch (e: Exception) { error = e.message ?: "Enter a valid positive amount." }
    }
    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Text("Engada Pochu", style = MaterialTheme.typography.headlineMedium)
        Text("Local-only money tracker · பணக் கணக்கு")
        Spacer(Modifier.height(14.dp))
        Text("Dashboard", style = MaterialTheme.typography.titleLarge)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Metric("Sent", sent); Metric("Received", received)
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Metric("Expenses", expenses); Metric("Balance", received - sent - expenses)
        }
        Spacer(Modifier.height(12.dp))
        Text("Voice entry · Review before saving")
        Button(onClick = onListen, modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Start voice input, review before saving" }) { Text("🎙 Tap to speak") }
        if (speechError.isNotBlank()) Text(speechError, color = MaterialTheme.colorScheme.error)
        if (recognized.isNotBlank()) {
            Text("Recognized: $recognized")
            OutlinedButton(onClick = {
                val result = VoiceParser.parse(recognized)
                result.onSuccess { parsed -> type = parsed.type; amount = "%.2f".format(Locale.US, parsed.amountMinor / 100.0); person = parsed.person; category = parsed.category; review("VOICE", parsed.original) }
                    .onFailure { onError(it.message ?: "Please correct the entry.") }
            }) { Text("Parse and review") }
        }
        OutlinedTextField(command, { command = it }, Modifier.fillMaxWidth(), label = { Text("Type a command · sent 500 to Ravi") }, singleLine = true)
        Button(onClick = { onRecognizedChange(command); val parsed=VoiceParser.parse(command); parsed.onSuccess { p -> type=p.type; amount="%.2f".format(Locale.US,p.amountMinor/100.0); person=p.person; category=p.category; review("MANUAL", command) }.onFailure { error=it.message ?: "Could not parse entry." } }, modifier = Modifier.fillMaxWidth()) { Text("Review command") }
        Text("Or enter transaction manually", style = MaterialTheme.typography.titleMedium)
        var selected by remember { mutableStateOf("SENT") }
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            listOf("SENT", "RECEIVED", "EXPENSE", "LENT", "BORROWED", "REFUND").forEach { t -> FilterChip(selected = selected == t, onClick = { selected = t; type = t }, label = { Text(t) }) }
        }
        OutlinedTextField(amount, { amount = it }, Modifier.fillMaxWidth(), label = { Text("Amount in ₹") })
        OutlinedTextField(person, { person = it }, Modifier.fillMaxWidth(), label = { Text("Person (not required for expense)") })
        OutlinedTextField(category, { category = it }, Modifier.fillMaxWidth(), label = { Text("Category") })
        OutlinedTextField(note, { note = it }, Modifier.fillMaxWidth(), label = { Text("Note") })
        if (error.isNotBlank()) Text(error, color = MaterialTheme.colorScheme.error)
        Button(onClick = { review("MANUAL") }, modifier = Modifier.fillMaxWidth()) { Text("Review transaction") }
        pending?.let { p ->
            AlertDialog(onDismissRequest = { pending = null }, title = { Text("Review before saving") }, text = { Text("${p.type} · ₹${p.amountMinor / 100}.${(p.amountMinor % 100).toString().padStart(2,'0')} · ${p.personName.ifBlank { p.category }}. Save this transaction?") }, confirmButton = { TextButton(onClick = { vm.save(p) { id -> undoId=id }; pending=null; amount=""; person=""; category=""; note=""; command=""; onRecognizedChange(""); error="Saved. You can undo the most recent entry." }) { Text("Confirm and save") } }, dismissButton = { TextButton(onClick = { pending=null }) { Text("Cancel") } })
        }
        if (undoId > 0L) TextButton(onClick = { vm.delete(undoId); undoId=0L; error="Saved entry removed. Use a backup for permanent history." }) { Text("Undo last save") }
        Spacer(Modifier.height(12.dp)); Text("History · வரலாறு", style = MaterialTheme.typography.titleLarge)
        OutlinedTextField(query, { query=it }, Modifier.fillMaxWidth(), label={Text("Search person, note, category")})
        if (visible.isEmpty()) Text("No transactions yet. Speak or enter a transaction above.")
        LazyColumn(Modifier.weight(1f)) {
            items(visible, key = { it.id }) { tx ->
                Card(Modifier.fillMaxWidth().padding(vertical=4.dp)) { Column(Modifier.padding(12.dp)) {
                    Text("${tx.type} · ₹${tx.amountMinor / 100}.${(tx.amountMinor % 100).toString().padStart(2,'0')}", style=MaterialTheme.typography.titleMedium)
                    Text(listOf(tx.personName,tx.category,tx.note).filter { it.isNotBlank() }.joinToString(" · ").ifBlank { "No extra details" })
                    Text("${tx.transactionDate} · ${tx.source}")
                    Row { TextButton(onClick={pending=tx.copy(id=0);type=tx.type;amount="%.2f".format(Locale.US,tx.amountMinor/100.0);person=tx.personName;category=tx.category;note=tx.note}) { Text("Duplicate") }; TextButton(onClick={vm.delete(tx.id);undoId=tx.id;error="Deleted. Undo is available below."}) { Text("Delete") }; TextButton(onClick={vm.update(tx.copy(note=tx.note+" "))}) { Text("Touch to update") } }
                } }
            }
        }
        Text("This month expense total: ₹${txs.filter { it.type == "EXPENSE" && it.transactionDate.startsWith(today.take(7)) }.sumOf { it.amountMinor } / 100}")
    }
}

@Composable private fun RowScope.Metric(label: String, minor: Long) {
    Card(Modifier.weight(1f).padding(vertical=3.dp)) { Column(Modifier.padding(10.dp)) { Text(label); Text("₹${minor / 100}.${(minor % 100).toString().padStart(2,'0')}", style=MaterialTheme.typography.titleMedium) } }
}
