package br.com.estoque.core.scanner

import android.os.Handler
import android.os.Looper
import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.LocalLifecycleOwner
import br.com.estoque.core.domain.BarcodeGate
import br.com.estoque.core.domain.ScanWindow
import br.com.estoque.core.ui.ActionButton
import br.com.estoque.core.ui.ActionStyle
import br.com.estoque.core.ui.AppScreen
import br.com.estoque.core.ui.StatusBanner
import br.com.estoque.core.ui.Tone
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** O que a câmera procura e como orienta quem está segurando o aparelho. */
enum class CameraScanMode(
    internal val formats: IntArray,
    internal val windowed: Boolean,
    internal val title: String,
    internal val hint: String,
    internal val back: String,
) {
    /**
     * Código de produto na gôndola: só formatos de varejo, que leem mais rápido, e só
     * dentro da janela de mira, para não pegar o produto vizinho.
     */
    PRODUCT(
        intArrayOf(
            Barcode.FORMAT_EAN_13,
            Barcode.FORMAT_EAN_8,
            Barcode.FORMAT_UPC_A,
            Barcode.FORMAT_UPC_E,
            Barcode.FORMAT_CODE_128,
            Barcode.FORMAT_ITF,
        ),
        windowed = true,
        title = "Escanear código",
        hint = "Centralize um código de barras. A leitura abre a consulta do produto.",
        back = "Voltar à consulta",
    ),

    /**
     * QR de acesso mostrado no painel. Só QR: um código de produto aqui não serve. Sem
     * janela: o QR é quadrado e não caberia na faixa horizontal, e na tela do painel
     * não existe vizinho para confundir.
     */
    PAIRING(
        intArrayOf(Barcode.FORMAT_QR_CODE),
        windowed = false,
        title = "Entrar com QR",
        hint = "No painel, abra Equipe da loja e escolha QR do coletor. Aponte para o código.",
        back = "Voltar ao login",
    ),
}

/** The app asks for camera permission before composing this adapter. */
@androidx.annotation.OptIn(ExperimentalGetImage::class)
@Composable
fun CameraScanner(
    onCode: (String) -> Unit,
    onCancel: () -> Unit,
    mode: CameraScanMode = CameraScanMode.PRODUCT,
) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current
    val currentOnCode by rememberUpdatedState(onCode)
    var error by remember { mutableStateOf<String?>(null) }
    // COMPATIBLE usa TextureView: o modo padrão desenha numa camada própria e passa
    // por cima do texto e do botão desta tela. O custo é irrelevante para leitura.
    val previewView =
        remember {
            PreviewView(context).apply { implementationMode = PreviewView.ImplementationMode.COMPATIBLE }
        }
    DisposableEffect(lifecycle, previewView, mode) {
        val active = AtomicBoolean(true)
        val delivered = AtomicBoolean(false)
        val gate = BarcodeGate()
        val handler = Handler(Looper.getMainLooper())
        val main = Executor { handler.post(it) }
        // Só os formatos do modo: menos candidatos por quadro, leitura mais rápida.
        val scanner =
            BarcodeScanning.getClient(
                BarcodeScannerOptions
                    .Builder()
                    .setBarcodeFormats(mode.formats.first(), *mode.formats.drop(1).toIntArray())
                    .build(),
            )
        // A análise dos quadros roda fora da thread principal; os resultados voltam nela.
        val analyzer = Executors.newSingleThreadExecutor()
        val analysis = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
        val preview = Preview.Builder().build().also { it.setSurfaceProvider(previewView.surfaceProvider) }
        val providerFuture = ProcessCameraProvider.getInstance(context)
        var provider: ProcessCameraProvider? = null
        analysis.setAnalyzer(analyzer) { proxy ->
            val media = proxy.image
            if (media == null || !active.get() || delivered.get()) {
                proxy.close()
            } else {
                try {
                    scanner
                        .process(InputImage.fromMediaImage(media, proxy.imageInfo.rotationDegrees))
                        .addOnSuccessListener { codes ->
                            if (active.get() && !delivered.get()) {
                                val (frameWidth, frameHeight) =
                                    ScanWindow.frameSize(
                                        media.width,
                                        media.height,
                                        proxy.imageInfo.rotationDegrees,
                                    )
                                val code =
                                    codes
                                        // Só o código mirado dentro da janela: na gôndola há
                                        // vários lado a lado e aceitar o vizinho lançaria a
                                        // validade no produto errado.
                                        .filter { barcode ->
                                            val box = barcode.boundingBox
                                            !mode.windowed ||
                                                box != null &&
                                                ScanWindow.accepts(
                                                    box.centerX(),
                                                    box.centerY(),
                                                    frameWidth,
                                                    frameHeight,
                                                )
                                        }.firstNotNullOfOrNull {
                                            it.rawValue?.let { value ->
                                                gate.accept(value, android.os.SystemClock.elapsedRealtime())
                                            }
                                        }
                                if (code != null && delivered.compareAndSet(false, true)) currentOnCode(code)
                            }
                        }.addOnFailureListener {
                            if (active.get()) {
                                error =
                                    "Não foi possível ler a imagem. Use o código digitado ou tente abrir a câmera novamente."
                            }
                        }.addOnCompleteListener { proxy.close() }
                } catch (_: Exception) {
                    proxy.close()
                    if (active.get()) error = "Leitura indisponível. Volte à consulta e digite o código."
                }
            }
        }
        providerFuture.addListener({
            if (active.get()) {
                try {
                    provider = providerFuture.get()
                    provider?.bindToLifecycle(lifecycle, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
                } catch (_: Exception) {
                    error = "Câmera indisponível neste dispositivo. Use o leitor físico ou digite o código."
                }
            }
        }, main)
        onDispose {
            active.set(false)
            analysis.clearAnalyzer()
            provider?.unbind(preview, analysis)
            scanner.close()
            analyzer.shutdown()
        }
    }
    AppScreen(
        title = mode.title,
        onBack = onCancel,
        bottomBar = { ActionButton(mode.back, onCancel, Modifier.fillMaxWidth(), style = ActionStyle.Secondary) },
    ) {
        Column(Modifier.fillMaxSize().padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(mode.hint, style = MaterialTheme.typography.bodyMedium)
            // clipToBounds: o preview se dimensiona pela proporção da câmera e, sem recorte,
            // passa por cima do texto acima e do botão abaixo na tela estreita do coletor.
            Box(
                Modifier
                    .fillMaxWidth()
                    .weight(1f)
                    .clip(MaterialTheme.shapes.medium)
                    .clipToBounds(),
            ) {
                AndroidView(factory = { previewView }, modifier = Modifier.fillMaxSize())
                if (mode.windowed) ScanWindowOverlay(Modifier.fillMaxSize())
            }
            error?.let { StatusBanner(it, Tone.Error) }
        }
    }
}

/**
 * Janela de leitura desenhada sobre o preview, como nos coletores de mercado: fora
 * dela a imagem é escurecida, dentro ficam os cantos e a linha de mira.
 *
 * As proporções vêm de [ScanWindow], as mesmas que decidem qual código é aceito —
 * o que o operador vê mirando é exatamente o que o aplicativo vai ler.
 */
@Composable
private fun ScanWindowOverlay(modifier: Modifier = Modifier) {
    Canvas(modifier) {
        val windowWidth = size.width * ScanWindow.WIDTH_FRACTION
        val windowHeight = size.height * ScanWindow.HEIGHT_FRACTION
        val left = (size.width - windowWidth) / 2f
        val top = (size.height - windowHeight) / 2f
        val dim = Color.Black.copy(alpha = 0.55f)

        // Escurece tudo que está fora da janela.
        drawRect(dim, size = Size(size.width, top))
        drawRect(dim, topLeft = Offset(0f, top + windowHeight), size = Size(size.width, top))
        drawRect(dim, topLeft = Offset(0f, top), size = Size(left, windowHeight))
        drawRect(dim, topLeft = Offset(left + windowWidth, top), size = Size(left, windowHeight))

        // Cantos, em vez de moldura fechada: sujam menos a imagem do código.
        val arm = windowWidth * 0.12f
        val stroke = 3.dp.toPx()
        val corner = Color.White
        listOf(
            Offset(left, top) to listOf(Offset(arm, 0f), Offset(0f, arm)),
            Offset(left + windowWidth, top) to listOf(Offset(-arm, 0f), Offset(0f, arm)),
            Offset(left, top + windowHeight) to listOf(Offset(arm, 0f), Offset(0f, -arm)),
            Offset(left + windowWidth, top + windowHeight) to listOf(Offset(-arm, 0f), Offset(0f, -arm)),
        ).forEach { (origin, arms) ->
            arms.forEach { direction ->
                drawLine(corner, origin, origin + direction, strokeWidth = stroke)
            }
        }

        // Linha de mira: o operador alinha o código por ela.
        drawLine(
            Color.Red.copy(alpha = 0.8f),
            Offset(left + arm, top + windowHeight / 2f),
            Offset(left + windowWidth - arm, top + windowHeight / 2f),
            strokeWidth = 2.dp.toPx(),
        )
    }
}
