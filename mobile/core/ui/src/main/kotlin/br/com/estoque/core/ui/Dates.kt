package br.com.estoque.core.ui

import br.com.estoque.core.domain.ExpiryDate
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale
import java.util.TimeZone

/** Data civil de hoje no fuso do aparelho, `YYYY-MM-DD`. */
fun todayIso(calendar: Calendar = Calendar.getInstance()): String =
    String.format(
        Locale.ROOT,
        "%04d-%02d-%02d",
        calendar.get(Calendar.YEAR),
        calendar.get(Calendar.MONTH) + 1,
        calendar.get(Calendar.DAY_OF_MONTH),
    )

private val instantPattern = Regex("""^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?Z$""")

/** Instante UTC da API (`2026-09-28T17:05:01.123456Z`) como `28/09/2026 14:05` no fuso do aparelho. */
fun formatInstant(
    iso: String?,
    zone: TimeZone = TimeZone.getDefault(),
): String {
    val match = iso?.let { instantPattern.matchEntire(it) } ?: return iso ?: "—"
    val parser = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.ROOT).apply { timeZone = TimeZone.getTimeZone("UTC") }
    val instant = parser.parse(match.groupValues[1]) ?: return iso
    return SimpleDateFormat("dd/MM/yyyy HH:mm", Locale.ROOT).apply { timeZone = zone }.format(instant)
}

fun deadlineText(days: Int): String =
    when {
        days < -1 -> "venceu há ${-days} dias"
        days == -1 -> "venceu ontem"
        days == 0 -> "vence hoje"
        days == 1 -> "vence amanhã"
        else -> "vence em $days dias"
    }

/** Dias de [today] até a data civil `YYYY-MM-DD`: negativo se já passou, null se não for data. */
fun daysUntil(
    iso: String,
    today: String = todayIso(),
): Int? {
    if (!ExpiryDate.isValidIso(iso) || !ExpiryDate.isValidIso(today)) return null

    fun epochDay(value: String): Long {
        val calendar =
            Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply {
                clear()
                set(value.substring(0, 4).toInt(), value.substring(5, 7).toInt() - 1, value.substring(8, 10).toInt())
            }
        return calendar.timeInMillis / 86_400_000L
    }
    return (epochDay(iso) - epochDay(today)).toInt()
}

/** `11222333000181` → `11.222.333/0001-81`; outro formato fica como veio. */
fun formatCnpj(value: String): String =
    if (value.length == 14) {
        "${value.substring(0, 2)}.${value.substring(2, 5)}.${value.substring(5, 8)}/${value.substring(8, 12)}-${value.substring(12)}"
    } else {
        value
    }
