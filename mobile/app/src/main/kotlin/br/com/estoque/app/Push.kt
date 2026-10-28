package br.com.estoque.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import br.com.estoque.core.domain.PushPort
import br.com.estoque.core.domain.PushSettings
import br.com.estoque.core.domain.Session
import br.com.estoque.core.domain.SessionPort
import com.google.android.gms.tasks.Task
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import javax.inject.Inject
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Canal das notificações de validade; o servidor manda o mesmo id no push. */
const val ALERTS_CHANNEL = "alertas"

/** Extra da intenção com a tela que o toque na notificação abre, como `/products/{id}`. */
const val PUSH_URL = "url"

private suspend fun <T> Task<T>.await(): T =
    suspendCancellableCoroutine { continuation ->
        addOnCompleteListener { task ->
            if (task.isSuccessful) {
                continuation.resume(task.result)
            } else {
                continuation.resumeWithException(task.exception ?: IllegalStateException("Firebase sem resposta."))
            }
        }
    }

/**
 * Push no coletor pelo Firebase (AV25), só para o proprietário. O app não traz a configuração do
 * Firebase embutida: pede ao servidor e inicia o Firebase com ela, então o mesmo APK serve a
 * qualquer servidor, e um servidor sem Firebase simplesmente não ativa o push.
 */
class PushRegistrar(
    private val context: Context,
    private val push: PushPort,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** Inscreve o aparelho se a sessão é de proprietário e o servidor tem Firebase. */
    fun sync(session: Session?) {
        if (session == null || !session.user.owner || session.mustChangePassword) return
        scope.launch {
            runCatching {
                val settings = push.settings()
                if (!settings.fcmAvailable || !start(settings)) return@runCatching
                push.register(currentToken())
            }.onFailure { Log.w(TAG, "Push não inscrito: ${it.message}") }
        }
    }

    /** Token novo do Firebase: vale para a sessão de agora, se ela recebe push. */
    fun refresh(
        session: Session?,
        token: String,
    ) {
        if (session == null || !session.user.owner || session.mustChangePassword) return
        scope.launch { runCatching { push.register(token) } }
    }

    /** Na saída: o servidor para de mandar para este aparelho. */
    suspend fun forget() {
        if (FirebaseApp.getApps(context).isEmpty()) return
        runCatching { push.unregister(currentToken()) }
    }

    /**
     * O token do aparelho. A versão 25 do Firebase marcou a leitura direta como obsoleta em favor
     * de `register()` com retorno no serviço ([AlertsMessagingService.onRegistered]); a leitura
     * continua valendo e é a única que devolve o token na hora, para a inscrição do login.
     */
    @Suppress("DEPRECATION")
    private suspend fun currentToken(): String = FirebaseMessaging.getInstance().token.await()

    private fun start(settings: PushSettings): Boolean {
        if (FirebaseApp.getApps(context).isNotEmpty()) return true
        val options =
            FirebaseOptions
                .Builder()
                .setProjectId(settings.fcmProjectId!!)
                .setApplicationId(settings.fcmAppId!!)
                .setApiKey(settings.fcmApiKey!!)
                .setGcmSenderId(settings.fcmSenderId!!)
                .build()
        return runCatching { FirebaseApp.initializeApp(context, options) }.isSuccess
    }

    private companion object {
        const val TAG = "Push"
    }
}

/** Cria o canal das notificações de validade (Android 8 em diante pede um canal). */
fun createAlertsChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    manager.createNotificationChannel(
        NotificationChannel(ALERTS_CHANNEL, "Alertas de validade", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Lotes que entram num nível de urgência, vencem ou são zerados pelas vendas, e o resumo do dia."
        },
    )
}

/**
 * Recebe o push do Firebase. Com o app fechado, o próprio Android mostra a notificação; com o app
 * aberto, ela chega aqui e é mostrada do mesmo jeito.
 */
@AndroidEntryPoint
class AlertsMessagingService : FirebaseMessagingService() {
    @Inject lateinit var registrar: PushRegistrar

    @Inject lateinit var sessions: SessionPort

    @Deprecated("Substituído por onRegistered no Firebase 25; mantido para aparelhos que ainda o chamam.")
    override fun onNewToken(token: String) {
        registrar.refresh(sessions.session.value, token)
    }

    override fun onRegistered(token: String) {
        registrar.refresh(sessions.session.value, token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val session = sessions.session.value ?: return
        if (!session.user.owner || session.mustChangePassword) return
        val notification = message.notification ?: return
        val url = message.data[PUSH_URL] ?: "/alerts"
        val open =
            PendingIntent.getActivity(
                this,
                url.hashCode(),
                Intent(this, MainActivity::class.java).putExtra(PUSH_URL, url).addFlags(
                    Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP,
                ),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        val built =
            NotificationCompat
                .Builder(this, ALERTS_CHANNEL)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(notification.title)
                .setContentText(notification.body)
                .setStyle(NotificationCompat.BigTextStyle().bigText(notification.body))
                .setAutoCancel(true)
                .setContentIntent(open)
                .build()
        show(message.data["tag"] ?: url, built)
    }

    @SuppressLint("MissingPermission") // conferida logo abaixo
    private fun show(
        tag: String,
        notification: android.app.Notification,
    ) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        runCatching { NotificationManagerCompat.from(this).notify(tag, 0, notification) }
    }
}
