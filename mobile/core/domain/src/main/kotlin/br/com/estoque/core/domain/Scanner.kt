package br.com.estoque.core.domain

enum class ScanSource { KEYBOARD, CAMERA, DEVICE }

data class BarcodeRead(
    val value: String,
    val source: ScanSource,
)

/**
 * Porta de entrada para o leitor do aparelho que entrega leituras sem depender do campo em foco,
 * como o Intent/broadcast dos coletores. Um modelo novo de coletor é um novo adapter desta
 * interface; as telas e casos de uso não mudam.
 */
interface DeviceScanner {
    /** Começa a escutar leituras; chamado quando o app fica visível. */
    fun start(onRead: (BarcodeRead) -> Unit)

    fun stop()
}

enum class ScannerMode {
    /** O leitor "digita" o código e envia Enter no campo em foco (keyboard wedge). */
    KEYBOARD,

    /** O leitor entrega a leitura por Intent/broadcast, configurado pela ação e pelo extra. */
    BROADCAST,
}

data class ScannerSettings(
    val mode: ScannerMode = ScannerMode.KEYBOARD,
    val action: String = "",
    val extra: String = "",
) {
    val isComplete: Boolean get() = mode == ScannerMode.KEYBOARD || (action.isNotBlank() && extra.isNotBlank())
}

data class ScannerPreset(
    val label: String,
    val action: String,
    val extra: String,
    val hint: String,
)

/**
 * Valores de fábrica publicados pelos fabricantes. Confira no manual do aparelho: vários modelos
 * permitem trocar a ação. Para outro fabricante, use "Personalizado" com a ação e o extra do manual.
 */
object ScannerPresets {
    val all =
        listOf(
            ScannerPreset(
                "Zebra (DataWedge)",
                "br.com.estoque.coletor.SCAN",
                "com.symbol.datawedge.data_string",
                "No DataWedge, crie um perfil para este app com saída Intent, entrega por broadcast e esta ação.",
            ),
            ScannerPreset(
                "Urovo",
                "android.intent.ACTION_DECODE_DATA",
                "barcode_string",
                "Nas configurações do leitor, escolha a saída por Intent.",
            ),
            ScannerPreset(
                "Sunmi",
                "com.sunmi.scanner.ACTION_DATA_CODE_RECEIVED",
                "data",
                "Nas configurações do leitor, habilite a saída por broadcast.",
            ),
            ScannerPreset(
                "Newland",
                "nlscan.action.SCANNER_RESULT",
                "SCAN_BARCODE1",
                "Nas configurações do leitor, escolha a saída por broadcast.",
            ),
        )
}

/**
 * Distingue a leitura de um leitor em modo teclado da digitação humana pelo ritmo das teclas:
 * o leitor "digita" o código inteiro em poucos milissegundos e termina com Enter. Usado para
 * impedir que um código lido caia no campo de quantidade ou de data.
 */
class ScanBurstDetector(
    private val maxIntervalMillis: Long = 50,
    private val minLength: Int = 4,
) {
    private val buffer = StringBuilder()
    private var lastAt = Long.MIN_VALUE

    /** Verdadeiro quando esta tecla inicia uma nova sequência (o campo ainda está como antes). */
    fun onCharacter(
        char: Char,
        atMillis: Long,
    ): Boolean {
        val starts = buffer.isEmpty() || atMillis - lastAt > maxIntervalMillis
        if (starts) buffer.setLength(0)
        buffer.append(char)
        lastAt = atMillis
        return starts
    }

    /** No Enter: o código lido, se a sequência veio no ritmo de um leitor; senão, null. */
    fun onEnter(atMillis: Long): String? {
        val code = buffer.toString()
        val scanned = code.length >= minLength && atMillis - lastAt <= maxIntervalMillis
        reset()
        return code.takeIf { scanned }
    }

    fun reset() {
        buffer.setLength(0)
        lastAt = Long.MIN_VALUE
    }
}
