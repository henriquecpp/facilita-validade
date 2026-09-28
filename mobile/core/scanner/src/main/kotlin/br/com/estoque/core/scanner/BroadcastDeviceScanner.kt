package br.com.estoque.core.scanner

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.SystemClock
import br.com.estoque.core.domain.BarcodeGate
import br.com.estoque.core.domain.BarcodeRead
import br.com.estoque.core.domain.DeviceScanner
import br.com.estoque.core.domain.ScanSource
import br.com.estoque.core.domain.ScannerMode
import br.com.estoque.core.domain.ScannerSettings

/**
 * Leitor do coletor configurado para entregar a leitura por Intent/broadcast (Zebra DataWedge,
 * Urovo, Sunmi, Newland e outros). A ação e o extra vêm das preferências do aparelho, então um
 * fabricante novo costuma exigir só configuração; um SDK proprietário vira outro [DeviceScanner].
 */
class BroadcastDeviceScanner(
    private val context: Context,
    private val settings: () -> ScannerSettings,
) : DeviceScanner {
    private var receiver: BroadcastReceiver? = null
    private val gate = BarcodeGate()

    override fun start(onRead: (BarcodeRead) -> Unit) {
        stop()
        val current = settings()
        if (current.mode != ScannerMode.BROADCAST || !current.isComplete) return
        val listener =
            object : BroadcastReceiver() {
                override fun onReceive(
                    context: Context,
                    intent: Intent,
                ) {
                    val raw =
                        intent.getStringExtra(current.extra)
                            ?: intent.getByteArrayExtra(current.extra)?.toString(Charsets.UTF_8)
                            ?: return
                    gate.accept(raw, SystemClock.elapsedRealtime())?.let { onRead(BarcodeRead(it, ScanSource.DEVICE)) }
                }
            }
        val filter = IntentFilter(current.action)
        // O serviço do leitor é outro app: o receptor precisa aceitar broadcasts externos.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.registerReceiver(listener, filter, Context.RECEIVER_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            context.registerReceiver(listener, filter)
        }
        receiver = listener
    }

    override fun stop() {
        receiver?.let { runCatching { context.unregisterReceiver(it) } }
        receiver = null
    }
}
