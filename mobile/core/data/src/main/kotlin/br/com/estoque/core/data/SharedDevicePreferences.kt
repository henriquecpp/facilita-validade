package br.com.estoque.core.data

import android.content.Context
import br.com.estoque.core.domain.DevicePreferences
import br.com.estoque.core.domain.LastLogin
import br.com.estoque.core.domain.ScannerMode
import br.com.estoque.core.domain.ScannerSettings

/** Preferências do aparelho sem segredos: CNPJ/usuário do último acesso e o modo do leitor. */
internal class SharedDevicePreferences(
    context: Context,
) : DevicePreferences {
    private val prefs = context.getSharedPreferences("device_preferences_v1", Context.MODE_PRIVATE)

    override fun lastLogin(): LastLogin? {
        val cnpj = prefs.getString("last_cnpj", null) ?: return null
        val username = prefs.getString("last_username", null) ?: return null
        return LastLogin(cnpj, username)
    }

    override fun rememberLogin(login: LastLogin) {
        prefs
            .edit()
            .putString("last_cnpj", login.cnpj)
            .putString("last_username", login.username)
            .apply()
    }

    override fun scannerSettings(): ScannerSettings {
        val mode = prefs.getString("scanner_mode", null)?.let { name -> ScannerMode.entries.firstOrNull { it.name == name } }
        return ScannerSettings(
            mode = mode ?: ScannerMode.KEYBOARD,
            action = prefs.getString("scanner_action", "").orEmpty(),
            extra = prefs.getString("scanner_extra", "").orEmpty(),
        )
    }

    override fun saveScannerSettings(settings: ScannerSettings) {
        prefs
            .edit()
            .putString("scanner_mode", settings.mode.name)
            .putString("scanner_action", settings.action.trim())
            .putString("scanner_extra", settings.extra.trim())
            .apply()
    }
}
