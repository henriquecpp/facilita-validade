package br.com.estoque.feature.auth

import br.com.estoque.core.domain.AppFailure
import br.com.estoque.core.domain.FakePreferences
import br.com.estoque.core.domain.FakeSession
import br.com.estoque.core.domain.LastLogin
import br.com.estoque.core.domain.Login
import br.com.estoque.core.domain.PairDevice
import br.com.estoque.core.domain.ScannerMode
import br.com.estoque.core.domain.ScannerPresets
import br.com.estoque.core.domain.ScannerSettings
import br.com.estoque.core.domain.Session
import br.com.estoque.core.domain.Store
import br.com.estoque.core.domain.User
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestCoroutineScheduler
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.IOException

private const val CODE = "estoque-pair:1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

private fun loginModel(
    session: FakeSession = FakeSession(),
    preferences: FakePreferences = FakePreferences(),
) = LoginViewModel(Login(session, preferences), preferences, PairDevice(session, preferences))

@OptIn(ExperimentalCoroutinesApi::class)
class AuthViewModelsTest {
    @Before fun setup() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
    }

    @After fun teardown() {
        Dispatchers.resetMain()
    }

    @Test fun `successful login remembers CNPJ and user, never the password`() {
        val preferences = FakePreferences()
        val model = loginModel(preferences = preferences)
        model.submit("04.252.011/0001-10", " ana ", "senha-muito-segura")
        assertEquals(LastLogin("04252011000110", "ana"), preferences.lastLogin())
        assertEquals(LastLogin("04252011000110", "ana"), loginModel(preferences = preferences).remembered)
        // O mesmo modelo, que segue vivo depois de sair ou de trocar a senha, também sabe.
        assertEquals(LastLogin("04252011000110", "ana"), model.remembered)
    }

    @Test fun `failed login does not overwrite the remembered access`() {
        val preferences = FakePreferences(LastLogin("04252011000110", "ana"))
        val session = FakeSession().apply { loginFailure = AppFailure("Credenciais inválidas.") }
        val model = loginModel(session, preferences)
        model.submit("04252011000110", "outra", "senha-errada-123")
        assertEquals("Credenciais inválidas.", model.state.value.error)
        assertEquals("ana", preferences.lastLogin()?.username)
    }

    @Test fun `QR code signs in and leaves CNPJ and user ready for a password login`() {
        val session = FakeSession()
        val preferences = FakePreferences()
        val model = loginModel(session, preferences)
        model.pair(CODE)
        assertEquals(listOf(CODE), session.pairedCodes)
        assertEquals(
            "repositor",
            session.session.value
                ?.user
                ?.username,
        )
        assertEquals(LastLogin("11222333000181", "repositor"), preferences.lastLogin())
        assertNull(model.state.value.error)
    }

    @Test fun `product barcode read on the login screen is ignored without an error`() {
        val session = FakeSession()
        val model = loginModel(session)
        model.pair("7890000000017")
        assertTrue(session.pairedCodes.isEmpty())
        assertNull(session.session.value)
        assertNull(model.state.value.error)
    }

    @Test fun `expired or used QR shows the server message and keeps the screen usable`() {
        val session = FakeSession().apply { pairFailure = AppFailure("Código de pareamento inválido ou expirado.") }
        val model = loginModel(session)
        model.pair(CODE)
        assertEquals("Código de pareamento inválido ou expirado.", model.state.value.error)
        assertFalse(model.state.value.busy)
        assertNull(session.session.value)
    }

    @Test fun `scanner preset is saved only when complete and restarts the reader`() {
        val preferences = FakePreferences()
        var restarts = 0
        val model = DeviceViewModel(preferences) { restarts++ }
        model.change(ScannerSettings(ScannerMode.BROADCAST, "", ""))
        model.save()
        assertEquals(0, restarts)
        assertFalse(model.state.value.saved)
        val urovo = ScannerPresets.all.first { it.label == "Urovo" }
        model.change(ScannerSettings(ScannerMode.BROADCAST, urovo.action, urovo.extra))
        model.save()
        assertEquals(1, restarts)
        assertTrue(model.state.value.saved)
        assertEquals("barcode_string", preferences.scannerSettings().extra)
        assertNull(model.state.value.lastRead)
    }

    private val operator = Session(Store("store", "Loja", "11222333000181"), User("op", "repositor", "OPERATOR"))

    @Test fun `app opened before the Wi-Fi keeps the stored session and enters by itself`() {
        val scheduler = TestCoroutineScheduler()
        Dispatchers.setMain(UnconfinedTestDispatcher(scheduler))
        val session =
            FakeSession().apply {
                stored = true
                restored = operator
                restoreFailures += IOException("sem rede")
                restoreFailures += IOException("sem rede")
            }
        val model = SessionViewModel(session, retryMillis = 1_000)
        // Sem rede: não vai para o login, tenta de novo.
        assertTrue(model.state.value.reconnecting)
        assertNull(session.session.value)
        scheduler.advanceTimeBy(1_001)
        assertTrue(model.state.value.reconnecting)
        scheduler.advanceTimeBy(1_001)
        assertFalse(model.state.value.reconnecting)
        assertEquals(
            "repositor",
            session.session.value
                ?.user
                ?.username,
        )
        assertEquals(3, session.restores)
    }

    @Test fun `session refused by the server goes to login with the reason`() {
        val session = FakeSession().apply { restoreFailures += AppFailure("Sua sessão expirou. Entre novamente.") }
        val model = SessionViewModel(session, retryMillis = 1_000)
        assertFalse(model.state.value.reconnecting)
        assertFalse(model.state.value.restoring)
        assertEquals("Sua sessão expirou. Entre novamente.", model.state.value.message)
    }

    @Test fun `session ended by the admin shows why on the login`() {
        val session = FakeSession(operator)
        val model = SessionViewModel(session, retryMillis = 1_000)
        assertNull(model.state.value.message)
        session.lastEndReason = "O administrador da loja desconectou este aparelho. Entre de novo para continuar."
        session.session.value = null
        assertEquals(session.lastEndReason, model.state.value.message)
    }

    @Test fun `logging out on the device is not reported as a disconnection`() {
        val session = FakeSession(operator)
        val model = SessionViewModel(session, retryMillis = 1_000)
        model.logout()
        assertEquals("Sessão encerrada.", model.state.value.message)
    }

    @Test fun `another account stops waiting for the network`() {
        val scheduler = TestCoroutineScheduler()
        Dispatchers.setMain(UnconfinedTestDispatcher(scheduler))
        val session =
            FakeSession().apply {
                stored = true
                restored = operator
                repeat(3) { restoreFailures += IOException("sem rede") }
            }
        val model = SessionViewModel(session, retryMillis = 1_000)
        model.useAnotherAccount()
        scheduler.advanceTimeBy(5_000)
        assertFalse(model.state.value.reconnecting)
        assertEquals(1, session.restores)
        assertNull(session.session.value)
    }
}
