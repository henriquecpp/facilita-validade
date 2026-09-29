package br.com.estoque.core.ui

import android.app.DatePickerDialog
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.TextFieldValue
import br.com.estoque.core.domain.ExpiryInput
import br.com.estoque.core.domain.ExpiryWarning
import java.util.Calendar
import java.util.Locale

fun expiryWarningText(warning: ExpiryWarning): String =
    when (warning) {
        ExpiryWarning.PAST -> "Esta validade já passou. Confira; Enter de novo confirma."
        ExpiryWarning.FAR -> "Validade a mais de ${ExpiryInput.FAR_FUTURE_YEARS} anos. Confira o ano; Enter de novo confirma."
    }

/**
 * Validade digitável pelo teclado físico: só números bastam (12042026 → 12/04/2026), qualquer
 * separador é aceito e o ano pode ter dois dígitos. O calendário é opcional e fica fora da
 * navegação por teclado.
 */
@Composable
fun ExpiryDateField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    label: String = "Validade",
    enabled: Boolean = true,
    readOnly: Boolean = false,
    error: String? = null,
    warning: ExpiryWarning? = null,
) {
    val context = LocalContext.current
    val invalid = value.length >= 8 && ExpiryInput.parse(value) == null
    val warned = error == null && !invalid && warning != null
    val supporting =
        when {
            error != null -> error
            invalid -> "Data inválida. Use dia, mês e ano: 12042026."
            warning != null -> expiryWarningText(warning)
            else -> null
        }
    OutlinedTextField(
        // O cursor fica sempre no fim: a máscara é recalculada a cada tecla.
        value = TextFieldValue(value, TextRange(value.length)),
        onValueChange = { onValueChange(ExpiryInput.mask(it.text)) },
        label = { Text(label) },
        placeholder = { Text("DD/MM/AAAA") },
        singleLine = true,
        enabled = enabled,
        readOnly = readOnly,
        isError = error != null || invalid,
        supportingText =
            supporting?.let { message ->
                {
                    // Aviso (data vencida ou muito distante) em âmbar: não é erro, mas pede atenção.
                    Text(
                        message,
                        color = if (warned) Tones.Warning else Color.Unspecified,
                        fontWeight = if (warned) FontWeight.SemiBold else null,
                    )
                }
            },
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
        trailingIcon = {
            IconButton(
                onClick = {
                    val initial = Calendar.getInstance()
                    ExpiryInput.parse(value)?.let {
                        initial.set(it.substring(0, 4).toInt(), it.substring(5, 7).toInt() - 1, it.substring(8, 10).toInt())
                    }
                    DatePickerDialog(context, { _, year, month, day ->
                        onValueChange(String.format(Locale.ROOT, "%02d/%02d/%04d", day, month + 1, year))
                    }, initial.get(Calendar.YEAR), initial.get(Calendar.MONTH), initial.get(Calendar.DAY_OF_MONTH)).show()
                },
                enabled = enabled && !readOnly,
                // Fora da navegação por Tab/Enter: o calendário é só para quem usa o toque.
                modifier = Modifier.focusProperties { canFocus = false },
            ) { GlyphIcon(Glyph.Calendar, "Abrir calendário", tint = MaterialTheme.colorScheme.primary) }
        },
        shape = MaterialTheme.shapes.small,
        colors = appFieldColors(),
        modifier = modifier,
    )
}
