package br.com.estoque.core.domain

import java.util.Locale

object Cnpj {
    fun normalize(value: String): String =
        value.trim().uppercase(Locale.ROOT).filterNot { it == '.' || it == '/' || it == '-' || it == ' ' }

    fun isValid(value: String): Boolean {
        val cnpj = normalize(value)
        if (!Regex("[A-Z0-9]{12}[0-9]{2}").matches(cnpj) || cnpj.all { it == cnpj[0] }) return false

        fun digit(prefix: String): Int {
            val weights =
                if (prefix.length ==
                    12
                ) {
                    intArrayOf(5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2)
                } else {
                    intArrayOf(6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2)
                }
            val remainder = prefix.mapIndexed { index, char -> (char.code - 48) * weights[index] }.sum() % 11
            return if (remainder < 2) 0 else 11 - remainder
        }
        return digit(cnpj.take(12)) == cnpj[12].digitToInt() && digit(cnpj.take(13)) == cnpj[13].digitToInt()
    }
}

object ExpiryDate {
    fun isValidIso(value: String): Boolean {
        if (!Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}").matches(value)) return false
        val year = value.substring(0, 4).toInt()
        val month = value.substring(5, 7).toInt()
        val day = value.substring(8, 10).toInt()
        if (year !in 1900..9999 || month !in 1..12) return false
        return day in 1..daysInMonth(year, month)
    }

    /** `YYYY-MM-DD` → `DD/MM/AAAA`, sem conversão de fuso. */
    fun format(iso: String): String = if (isValidIso(iso)) "${iso.substring(8, 10)}/${iso.substring(5, 7)}/${iso.substring(0, 4)}" else iso

    internal fun daysInMonth(
        year: Int,
        month: Int,
    ): Int {
        val leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
        return intArrayOf(31, if (leap) 29 else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)[month - 1]
    }
}

enum class ExpiryWarning { PAST, FAR }

/**
 * Digitação da validade pelo teclado físico do coletor. Mesmas regras do painel web, conferidas
 * pelos casos de `contracts/fixtures/expiry-input.json`: só dígitos bastam (`12042026`),
 * separadores `.`, `/`, `-` ou espaço são aceitos e o ano pode ter dois dígitos (vira 20AA).
 */
object ExpiryInput {
    const val FAR_FUTURE_YEARS = 5
    private val partLength = intArrayOf(2, 2, 4)
    private val separators = Regex("[./\\-\\s]+")

    private fun isSeparator(char: Char) = char == '.' || char == '/' || char == '-' || char.isWhitespace()

    private fun String.isAsciiDigits() = isNotEmpty() && all { it in '0'..'9' }

    /** Máscara progressiva `DD/MM/AAAA`, recalculada a partir de tudo que está no campo. */
    fun mask(raw: String): String {
        val parts = arrayOf(StringBuilder(), StringBuilder(), StringBuilder())
        var index = 0
        for (char in raw) {
            if (char in '0'..'9') {
                if (parts[index].length == partLength[index]) {
                    if (index == 2) continue
                    index++
                }
                parts[index].append(char)
            } else if (isSeparator(char) && index < 2 && parts[index].isNotEmpty()) {
                if (parts[index].length == 1) parts[index].insert(0, '0')
                index++
            }
        }
        return parts.take(index + 1).joinToString("/")
    }

    /** Converte o que foi digitado em data ISO `YYYY-MM-DD`, ou null se não for uma data real. */
    fun parse(value: String): String? {
        val text = value.trim()
        val day: String
        val month: String
        val year: String
        if (text.isAsciiDigits()) {
            if (text.length != 6 && text.length != 8) return null
            day = text.substring(0, 2)
            month = text.substring(2, 4)
            year = text.substring(4)
        } else {
            val parts = text.split(separators)
            if (parts.size != 3 || !parts.all { it.isAsciiDigits() }) return null
            day = parts[0]
            month = parts[1]
            year = parts[2]
            if (day.length > 2 || month.length > 2 || (year.length != 2 && year.length != 4)) return null
        }
        val y = if (year.length == 2) 2000 + year.toInt() else year.toInt()
        val m = month.toInt()
        val d = day.toInt()
        if (y !in 2000..2099 || m !in 1..12 || d !in 1..ExpiryDate.daysInMonth(y, m)) return null
        return String.format(Locale.ROOT, "%04d-%02d-%02d", y, m, d)
    }

    /** Datas legítimas, mas suspeitas de erro de digitação: pedem confirmação. */
    fun warning(
        iso: String,
        today: String,
    ): ExpiryWarning? {
        if (iso < today) return ExpiryWarning.PAST
        val limit = "${today.substring(0, 4).toInt() + FAR_FUTURE_YEARS}${today.substring(4)}"
        return if (iso > limit) ExpiryWarning.FAR else null
    }
}

/**
 * Conferência do EAN-13 (GS1): os 12 primeiros dígitos, com pesos 1 e 3 alternados, dão o último.
 * Um código de 13 dígitos que não confere foi lido ou digitado errado, e nem vale consultar. Só o
 * EAN-13 é conferido; os outros formatos seguem para a consulta como vieram.
 */
object Ean13 {
    fun invalid(code: String): Boolean {
        if (code.length != 13 || code.any { it !in '0'..'9' }) return false
        val sum = (0 until 12).sumOf { (code[it] - '0') * if (it % 2 == 0) 1 else 3 }
        return (10 - sum % 10) % 10 != code[12] - '0'
    }

    fun message(code: String) =
        "O código $code não é um EAN-13 válido: o último dígito não confere com os anteriores. Leia de novo ou confira os números."
}

/** Scanner duplicate filtering does not alter stock quantities. */
class BarcodeGate(
    private val debounceMillis: Long = 1000,
) {
    private var lastCode: String? = null
    private var lastTime = Long.MIN_VALUE

    @Synchronized fun accept(
        value: String,
        nowMillis: Long,
    ): String? {
        val code = value.trimEnd('\r', '\n').trim()
        if (code.isEmpty() || code.length > 128 || code.any { it.isISOControl() }) return null
        if (code == lastCode && nowMillis - lastTime in 0 until debounceMillis) return null
        lastCode = code
        lastTime = nowMillis
        return code
    }
}
