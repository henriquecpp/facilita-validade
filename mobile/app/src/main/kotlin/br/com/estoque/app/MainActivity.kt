package br.com.estoque.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.windowInsetsTopHeight
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.LocalViewModelStoreOwner
import androidx.lifecycle.viewmodel.compose.viewModel
import br.com.estoque.core.domain.DevicePreferences
import br.com.estoque.core.domain.DeviceScanner
import br.com.estoque.core.domain.InventoryPort
import br.com.estoque.core.domain.Login
import br.com.estoque.core.domain.PairDevice
import br.com.estoque.core.domain.PairingCode
import br.com.estoque.core.domain.PushDestination
import br.com.estoque.core.domain.Session
import br.com.estoque.core.domain.SessionPort
import br.com.estoque.core.scanner.CameraScanMode
import br.com.estoque.core.scanner.CameraScanner
import br.com.estoque.core.ui.ActionButton
import br.com.estoque.core.ui.ActionStyle
import br.com.estoque.core.ui.ConfirmDialog
import br.com.estoque.core.ui.EstoqueTheme
import br.com.estoque.core.ui.Glyph
import br.com.estoque.core.ui.HandleScans
import br.com.estoque.core.ui.LocalScanRouter
import br.com.estoque.core.ui.ScanRouter
import br.com.estoque.core.ui.Tones
import br.com.estoque.core.ui.defaultAction
import br.com.estoque.core.ui.todayIso
import br.com.estoque.feature.auth.ChangePasswordScreen
import br.com.estoque.feature.auth.DeviceScreen
import br.com.estoque.feature.auth.DeviceViewModel
import br.com.estoque.feature.auth.LoginScreen
import br.com.estoque.feature.auth.LoginViewModel
import br.com.estoque.feature.auth.SessionViewModel
import br.com.estoque.feature.counting.CountingScreen
import br.com.estoque.feature.counting.CountingViewModel
import br.com.estoque.feature.inventory.EntryScreen
import br.com.estoque.feature.inventory.EntryViewModel
import br.com.estoque.feature.inventory.ExpiriesScreen
import br.com.estoque.feature.inventory.ExpiriesViewModel
import br.com.estoque.feature.inventory.ProductKey
import br.com.estoque.feature.inventory.ProductScreen
import br.com.estoque.feature.inventory.ProductViewModel
import br.com.estoque.feature.inventory.QuickEntryScreen
import br.com.estoque.feature.inventory.QuickEntryViewModel
import br.com.estoque.feature.inventory.SearchScreen
import br.com.estoque.feature.inventory.SearchViewModel
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import javax.inject.Inject

@AndroidEntryPoint
class MainActivity : ComponentActivity() {
    @Inject lateinit var session: SessionPort

    @Inject lateinit var inventory: InventoryPort

    @Inject lateinit var preferences: DevicePreferences

    @Inject lateinit var scanner: DeviceScanner

    @Inject lateinit var push: PushRegistrar

    private val router = ScanRouter()

    /** Tela pedida pelo toque numa notificação push, como `/products/{id}`. */
    private val link = MutableStateFlow<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        link.value = intent?.getStringExtra(PUSH_URL)
        val services = AppServices(session, inventory, preferences, ::restartScanner, push, link)
        setContent {
            EstoqueTheme {
                CompositionLocalProvider(LocalScanRouter provides router) { EstoqueApp(services) }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.getStringExtra(PUSH_URL)?.let { link.value = it }
    }

    override fun onResume() {
        super.onResume()
        scanner.start { router.dispatch(it.value) }
    }

    override fun onPause() {
        scanner.stop()
        super.onPause()
    }

    private fun restartScanner() {
        scanner.stop()
        scanner.start { router.dispatch(it.value) }
    }

    /** Esc do teclado físico funciona como a tecla Voltar do coletor. */
    override fun onKeyDown(
        keyCode: Int,
        event: KeyEvent,
    ): Boolean = keyCode == KeyEvent.KEYCODE_ESCAPE || super.onKeyDown(keyCode, event)

    override fun onKeyUp(
        keyCode: Int,
        event: KeyEvent,
    ): Boolean {
        if (keyCode == KeyEvent.KEYCODE_ESCAPE) {
            onBackPressedDispatcher.onBackPressed()
            return true
        }
        return super.onKeyUp(keyCode, event)
    }
}

class AppServices(
    val session: SessionPort,
    val inventory: InventoryPort,
    val preferences: DevicePreferences,
    val restartScanner: () -> Unit,
    val push: PushRegistrar,
    /** Tela pedida por uma notificação; a navegação consome e limpa. */
    val link: MutableStateFlow<String?>,
)

private inline fun <reified T : ViewModel> factory(crossinline create: () -> T): ViewModelProvider.Factory =
    object : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <V : ViewModel> create(modelClass: Class<V>): V = create() as V
    }

@Composable
private fun EstoqueApp(services: AppServices) {
    val controller: SessionViewModel = viewModel(factory = factory { SessionViewModel(services.session) })
    val state by controller.state.collectAsStateWithLifecycle()
    val identity by controller.session.collectAsStateWithLifecycle()
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(Modifier.fillMaxSize()) {
            // Faixa da barra de status na cor do app. Até o Android 14 a cor vem do tema e esta
            // faixa tem altura zero; do 15 em diante o app desenha atrás da barra e ela assume.
            Spacer(Modifier.fillMaxWidth().windowInsetsTopHeight(WindowInsets.statusBars).background(Tones.BrandDark))
            Box(
                Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal + WindowInsetsSides.Bottom)),
            ) {
                val current = identity
                when {
                    state.restoring -> Restoring()
                    current == null && state.reconnecting ->
                        Reconnecting(state.message, controller::retryRestore, controller::useAnotherAccount)
                    current == null -> LoginFlow(services, state.message)
                    else ->
                        // Outra loja/usuário recebe navegação e ViewModels novos, sem estado anterior.
                        key(current.store.id, current.user.id) {
                            LaunchedEffect(Unit) { controller.clearMessage() }
                            if (current.mustChangePassword) {
                                ChangePasswordScreen(state, controller::changePassword, controller::logout)
                            } else {
                                StoreScreens(current, services, controller)
                            }
                        }
                }
            }
        }
    }
}

@Composable
private fun Restoring() {
    Column(
        Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        CircularProgressIndicator(color = MaterialTheme.colorScheme.primary)
        Text("Restaurando sessão…", style = MaterialTheme.typography.bodyMedium)
    }
}

/**
 * Sessão guardada, mas sem servidor ao abrir: o app tenta de novo sozinho. Entrar com outra
 * conta continua possível, sem esperar a rede voltar.
 */
@Composable
private fun Reconnecting(
    message: String?,
    retry: () -> Unit,
    otherAccount: () -> Unit,
) {
    // Enter tenta de novo: o coletor é operado pelo teclado.
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    Column(
        Modifier.fillMaxSize().padding(horizontal = 24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        CircularProgressIndicator(color = MaterialTheme.colorScheme.primary)
        Text(message ?: "Sem conexão com o servidor.", style = MaterialTheme.typography.bodyMedium)
        Text(
            "A sessão deste aparelho continua guardada: assim que a rede voltar, o app entra sozinho.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        ActionButton("Tentar agora", retry, Modifier.fillMaxWidth().focusRequester(focus).defaultAction(), glyph = Glyph.Refresh)
        ActionButton("Entrar com outra conta", otherAccount, Modifier.fillMaxWidth(), style = ActionStyle.Quiet)
    }
}

/**
 * Login com senha ou pelo QR do painel. Fica fora do [Navigator], que só existe depois
 * de entrar; por isso a câmera de pareamento tem estado e permissão próprios aqui.
 */
@Composable
private fun LoginFlow(
    services: AppServices,
    notice: String?,
) {
    val login: LoginViewModel =
        viewModel(
            factory =
                factory {
                    LoginViewModel(
                        Login(services.session, services.preferences),
                        services.preferences,
                        PairDevice(services.session, services.preferences),
                    )
                },
        )
    val context = LocalContext.current
    var camera by rememberSaveable { mutableStateOf(false) }
    var cameraMessage by remember { mutableStateOf<String?>(null) }
    val permission =
        rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) {
                camera = true
            } else {
                cameraMessage = "Sem permissão de câmera. Leia o QR com o leitor do coletor."
            }
        }
    if (camera) {
        BackHandler { camera = false }
        CameraScanner(
            mode = CameraScanMode.PAIRING,
            onCode = { code ->
                camera = false
                // Pedido explícito de ler o QR de acesso: outro QR merece explicação,
                // ao contrário de um produto bipado por engano na tela de login.
                if (PairingCode.recognizes(code)) {
                    cameraMessage = null
                    login.pair(code)
                } else {
                    cameraMessage = "Esse QR não é de acesso. No painel, abra Equipe da loja e escolha QR do coletor."
                }
            },
            onCancel = { camera = false },
        )
    } else {
        LoginScreen(
            login,
            notice ?: cameraMessage,
            appVersion = BuildConfig.VERSION_NAME,
            onPairWithCamera = {
                if (context.checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                    camera = true
                } else {
                    permission.launch(Manifest.permission.CAMERA)
                }
            },
        )
    }
}

@Composable
private fun StoreScreens(
    identity: Session,
    services: AppServices,
    controller: SessionViewModel,
) {
    val navigator = remember { Navigator() }
    DisposableEffect(navigator) { onDispose { navigator.clear() } }
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val sessionState by controller.state.collectAsStateWithLifecycle()
    var cameraDenied by remember { mutableStateOf(false) }
    val router = LocalScanRouter.current
    val permission =
        rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) navigator.push(Screen.Camera) else cameraDenied = true
        }
    val openCamera = {
        if (context.checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            navigator.push(Screen.Camera)
        } else {
            permission.launch(Manifest.permission.CAMERA)
        }
    }
    val openBarcode: (String) -> Unit = { navigator.openProduct(ProductKey.Barcode(it)) }
    val openSearch: (String) -> Unit = { navigator.push(Screen.Search(it)) }
    val message: (String) -> Unit = { text -> scope.launch { snackbar.showSnackbar(text) } }
    // Proprietário: o aparelho se inscreve no push da loja, se o servidor tiver o Firebase (AV25).
    val notifications =
        rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { services.push.sync(identity) }
    LaunchedEffect(identity.store.id, identity.user.id) {
        if (!identity.user.owner) return@LaunchedEffect
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            notifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            services.push.sync(identity)
        }
    }
    // Toque numa notificação: produto, nível específico ou lista geral, somente na sessão do proprietário.
    val link by services.link.collectAsStateWithLifecycle()
    LaunchedEffect(link) {
        val target = link ?: return@LaunchedEffect
        services.link.value = null
        if (!identity.user.owner) return@LaunchedEffect
        when (val destination = PushDestination.parse(target)) {
            is PushDestination.Product -> navigator.openProduct(ProductKey.Id(destination.id))
            is PushDestination.Expiries -> navigator.openExpiries(destination.levelId)
            null -> Unit
        }
    }
    val logout: () -> Unit = {
        scope.launch {
            withTimeoutOrNull(3_000) { services.push.forget() }
            controller.logout()
        }
    }
    // Tratador padrão: uma leitura em qualquer tela sem regra própria abre o produto.
    HandleScans(openBarcode)
    BackHandler(enabled = navigator.canGoBack) { navigator.pop() }
    val entry = navigator.top
    // As margens do sistema já foram aplicadas na raiz.
    Scaffold(snackbarHost = { SnackbarHost(snackbar) }, contentWindowInsets = WindowInsets(0, 0, 0, 0)) { padding ->
        Box(Modifier.padding(padding)) {
            // Cada tela da pilha tem a sua composição: um produto lido por cima de outro começa do
            // zero (carga, campos, foco), em vez de herdar os efeitos da tela que ele substituiu.
            key(entry) {
                CompositionLocalProvider(LocalViewModelStoreOwner provides entry) {
                    when (val screen = entry.screen) {
                        is Screen.Expiries -> {
                            val model: ExpiriesViewModel =
                                viewModel(factory = factory { ExpiriesViewModel(services.inventory, screen.levelId) })
                            ExpiriesScreen(
                                model,
                                storeName = identity.store.name,
                                onOpenBarcode = openBarcode,
                                onOpenProduct = { navigator.openProduct(ProductKey.Id(it)) },
                                onQuickEntry = { navigator.push(Screen.QuickEntry) },
                                onSearch = { openSearch("") },
                                onDevice = { navigator.push(Screen.Device) },
                            )
                        }
                        is Screen.ProductView -> {
                            val model: ProductViewModel = viewModel(factory = factory { ProductViewModel(services.inventory, screen.key) })
                            ProductScreen(
                                model,
                                onOpenBarcode = openBarcode,
                                onEntry = { navigator.push(Screen.EntryForm(it)) },
                                onCount = { navigator.push(Screen.Counting(it)) },
                                onBack = { navigator.pop() },
                            )
                        }
                        Screen.QuickEntry -> {
                            val model: QuickEntryViewModel = viewModel(factory = factory { QuickEntryViewModel(services.inventory) })
                            QuickEntryScreen(
                                model,
                                services.inventory,
                                { todayIso() },
                                onInitialCount = { navigator.push(Screen.Counting(it)) },
                                onCamera = openCamera,
                                onSearch = openSearch,
                                onBack = { navigator.pop() },
                            )
                        }
                        is Screen.Search -> {
                            val model: SearchViewModel = viewModel(factory = factory { SearchViewModel(services.inventory, screen.text) })
                            SearchScreen(
                                model,
                                onOpenProduct = { navigator.openProduct(ProductKey.Id(it)) },
                                onOpenBarcode = openBarcode,
                                onBack = { navigator.pop() },
                            )
                        }
                        is Screen.EntryForm -> {
                            val model: EntryViewModel =
                                viewModel(factory = factory { EntryViewModel(services.inventory, screen.product) { todayIso() } })
                            EntryScreen(model, onOpenBarcode = openBarcode, onBack = { navigator.pop() })
                        }
                        is Screen.Counting -> {
                            val model: CountingViewModel =
                                viewModel(factory = factory { CountingViewModel(services.inventory, screen.product, { todayIso() }) })
                            CountingScreen(
                                model,
                                onFinished = { count ->
                                    navigator.pop()
                                    message(
                                        if (count.status ==
                                            "CONFIRMED"
                                        ) {
                                            "Contagem confirmada: saldo atualizado."
                                        } else {
                                            "Contagem cancelada."
                                        },
                                    )
                                },
                                onBack = { navigator.pop() },
                            )
                        }
                        Screen.Device -> {
                            val model: DeviceViewModel =
                                viewModel(factory = factory { DeviceViewModel(services.preferences, services.restartScanner) })
                            DeviceScreen(
                                model,
                                identity,
                                BuildConfig.VERSION_NAME,
                                onChangePassword = { navigator.push(Screen.ChangePassword) },
                                onLogout = logout,
                                onBack = { navigator.pop() },
                            )
                        }
                        Screen.ChangePassword ->
                            ChangePasswordScreen(sessionState, controller::changePassword, controller::logout, onBack = { navigator.pop() })
                        Screen.Camera ->
                            CameraScanner(onCode = { code ->
                                navigator.pop()
                                router.dispatch(code)
                            }, onCancel = { navigator.pop() })
                    }
                }
            }
        }
    }
    // Só recados desta sessão: o de antes de entrar ("Sessão encerrada.") já apareceu no login.
    // Na troca de senha, o recado aparece na própria tela.
    val previous = remember { sessionState.message }
    sessionState.message
        ?.takeIf { it != previous && entry.screen != Screen.ChangePassword }
        ?.let { LaunchedEffect(it) { message(it) } }
    if (cameraDenied) {
        ConfirmDialog(
            title = "Câmera sem permissão",
            confirmLabel = "Entendi",
            onConfirm = { cameraDenied = false },
            onDismiss = { cameraDenied = false },
            dismissLabel = null,
        ) { Text("Autorize a câmera nas configurações do aplicativo. A digitação e o leitor físico continuam disponíveis.") }
    }
}
