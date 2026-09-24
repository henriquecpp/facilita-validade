package br.com.estoque.core.network

import br.com.estoque.core.domain.AppFailure
import br.com.estoque.core.domain.Entry
import br.com.estoque.core.domain.StockRecord
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.net.InetAddress
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class NetworkAdaptersTest {
    private lateinit var server: MockWebServer
    private lateinit var vault: MemoryVault
    private lateinit var adapters: NetworkAdapters
    private val entry = Entry("product-a", 4, "2027-03-15", null, null)

    @Before
    fun setup() {
        // Só IPv4: com "localhost" o OkHttp também tentaria ::1, onde o servidor de teste não escuta.
        server = MockWebServer().apply { start(InetAddress.getByName("127.0.0.1"), 0) }
        vault = MemoryVault()
        adapters = NetworkAdapters.create(server.url("/api/v1/").toString(), vault)
    }

    @After
    fun close() {
        server.shutdown()
    }

    private fun response(
        body: String,
        code: Int = 200,
    ): MockResponse = MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)

    private fun identity(
        store: String = "store-a",
        access: String = "access-a",
        refresh: String = "refresh-a",
        temporary: Boolean = false,
    ): String =
        """{"accessToken":"$access","refreshToken":"$refresh","mustChangePassword":$temporary,"user":{"id":"operator-a","username":"ana","role":"MANAGER","storeId":"$store"},"store":{"id":"$store","name":"Loja","cnpj":"04252011000110"}}"""

    private suspend fun login(store: String = "store-a") {
        server.enqueue(response(identity(store)))
        adapters.session.login("04252011000110", "ana", "test-password")
        server.takeRequest()
    }

    @Test
    fun `uncertain command is preserved and repeated with identical key and body`() =
        runBlocking {
            login()
            server.enqueue(response("{}", 503))
            val failed = runCatching { adapters.inventory.receive(entry) }.exceptionOrNull()
            assertTrue(failed is AppFailure && failed.uncertain)
            val original = server.takeRequest()
            val pending = checkNotNull(adapters.inventory.pendingCommand())
            assertEquals(original.getHeader("Idempotency-Key"), pending.key)
            val blocked = runCatching { adapters.inventory.receive(entry.copy(quantity = 9)) }.exceptionOrNull()
            // O segundo nem saiu do aparelho: erro certo, que aponta o lançamento pendente. Como
            // incerto, a tela reenviaria o primeiro e anunciaria o segundo como registrado.
            assertTrue(blocked is AppFailure && !blocked.uncertain)
            assertTrue(blocked!!.message!!.contains("Entrada de 4 unidade(s)"))
            server.enqueue(response("{\"message\":\"Receipt missing\"}", 404))
            assertFalse(adapters.inventory.recoverCommand())
            assertNotNull(adapters.inventory.pendingCommand())
            server.takeRequest()
            server.enqueue(response("{\"id\":\"receipt-a\"}"))
            adapters.inventory.retryPendingCommand()
            val repeated = server.takeRequest()
            assertEquals(original.getHeader("Idempotency-Key"), repeated.getHeader("Idempotency-Key"))
            assertEquals(original.body.readUtf8(), repeated.body.readUtf8())
            assertNull(adapters.inventory.pendingCommand())
        }

    @Test
    fun `disconnected response preserves the command until receipt confirms it`() =
        runBlocking {
            login()
            // O envio cai sempre depois de chegar ao servidor; as novas tentativas automáticas, com
            // a mesma chave, também: o comando fica pendente, como incerto.
            val keys = mutableSetOf<String?>()
            server.dispatcher =
                object : Dispatcher() {
                    override fun dispatch(request: RecordedRequest): MockResponse {
                        if (request.method == "POST") {
                            keys += request.getHeader("Idempotency-Key")
                            return MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
                        }
                        return response(
                            """{"operation":"inventory.receipt","idempotencyKey":"${keys.single()}","result":{"id":"receipt-a"}}""",
                        )
                    }
                }
            val failed = runCatching { adapters.inventory.receive(entry) }.exceptionOrNull()
            assertTrue(failed is AppFailure && failed.uncertain)
            assertEquals(1, keys.size)
            assertNotNull(adapters.inventory.pendingCommand())
            assertTrue(adapters.inventory.recoverCommand())
            assertNull(adapters.inventory.pendingCommand())
        }

    @Test
    fun `definitive validation failure releases pending command`() =
        runBlocking {
            login()
            server.enqueue(response("{\"message\":\"Faça a contagem inicial.\"}", 422))
            val failed = runCatching { adapters.inventory.receive(entry) }.exceptionOrNull()
            assertTrue(failed is AppFailure && !failed.uncertain && failed.statusCode == 422)
            assertNull(adapters.inventory.pendingCommand())
        }

    @Test
    fun `collector disconnected by the admin learns why when renewing the session`() =
        runBlocking {
            login()
            val reason = "O administrador da loja desconectou este aparelho. Entre de novo para continuar."
            server.enqueue(response("""{"code":"INVALID_SESSION","message":"Sessão inválida ou expirada."}""", 401))
            server.enqueue(response("""{"code":"SESSION_REVOKED","message":"$reason"}""", 401))
            val failure = runCatching { adapters.inventory.expiries() }.exceptionOrNull()
            assertTrue(failure is AppFailure && failure.message == reason)
            assertNull(adapters.session.session.value)
            assertEquals(reason, adapters.session.lastEndReason)
            // Entrar de novo apaga o motivo da sessão anterior.
            login()
            assertNull(adapters.session.lastEndReason)
        }

    @Test
    fun `temporary password session cannot retain a prior refresh token`() =
        runBlocking {
            vault.write("refresh", "previous-token")
            server.enqueue(response(identity(refresh = "", temporary = true)))
            adapters.session.login("04252011000110", "ana", "temporary-password")
            server.takeRequest()
            assertTrue(checkNotNull(adapters.session.session.value).mustChangePassword)
            assertNull(vault.read("refresh"))
            server.enqueue(response("{}"))
            adapters.session.changePassword("temporary-password", "replacement-password")
            val request = server.takeRequest()
            assertEquals("/api/v1/auth/change-password", request.path)
            assertEquals("Bearer access-a", request.getHeader("Authorization"))
            assertNull(adapters.session.session.value)
        }

    @Test
    fun `concurrent unauthorized calls rotate refresh only once`() =
        runBlocking {
            login()
            val refreshes = AtomicInteger()
            server.dispatcher =
                object : Dispatcher() {
                    override fun dispatch(request: RecordedRequest): MockResponse =
                        when {
                            request.path == "/api/v1/auth/mobile/refresh" -> {
                                refreshes.incrementAndGet()
                                response(identity(access = "access-b", refresh = "refresh-b"))
                            }
                            request.getHeader("Authorization") == "Bearer access-a" -> response("{}", 401)
                            request.getHeader(
                                "Authorization",
                            ) == "Bearer access-b" -> response("{\"id\":\"product-a\",\"description\":\"Iogurte\",\"active\":true}")
                            else -> response("{}", 403)
                        }
                }
            val products = listOf(async { adapters.inventory.lookup("00123") }, async { adapters.inventory.lookup("00123") }).awaitAll()
            assertEquals(listOf("product-a", "product-a"), products.map { it.id })
            assertEquals(1, refreshes.get())
            assertEquals("refresh-b", vault.read("refresh"))
        }

    @Test
    fun `old unauthorized request cannot be repeated in another store`() =
        runBlocking {
            login()
            val started = CountDownLatch(1)
            val release = CountDownLatch(1)
            val lookupCalls = AtomicInteger()
            val refreshCalls = AtomicInteger()
            server.dispatcher =
                object : Dispatcher() {
                    override fun dispatch(request: RecordedRequest): MockResponse =
                        when (request.path) {
                            "/api/v1/auth/mobile/login" -> response(identity("store-b", "access-b", "refresh-b"))
                            "/api/v1/auth/mobile/refresh" -> {
                                refreshCalls.incrementAndGet()
                                response(identity("store-b", "access-b", "refresh-b"))
                            }
                            else -> {
                                lookupCalls.incrementAndGet()
                                started.countDown()
                                check(release.await(10, TimeUnit.SECONDS))
                                response("{}", 401)
                            }
                        }
                }
            val oldRequest = async { runCatching { adapters.inventory.lookup("00123") }.exceptionOrNull() }
            assertTrue(withContext(Dispatchers.IO) { started.await(10, TimeUnit.SECONDS) })
            adapters.session.login("04252011000110", "ana", "test-password")
            release.countDown()
            val failure = oldRequest.await()
            assertTrue(failure is AppFailure && failure.uncertain)
            assertEquals(1, lookupCalls.get())
            assertEquals(0, refreshCalls.get())
            assertEquals(
                "store-b",
                adapters.session.session.value
                    ?.store
                    ?.id,
            )
        }

    @Test
    fun `logout waits for refresh and cannot be undone by its response`() =
        runBlocking {
            login()
            val refreshStarted = CountDownLatch(1)
            val releaseRefresh = CountDownLatch(1)
            server.dispatcher =
                object : Dispatcher() {
                    override fun dispatch(request: RecordedRequest): MockResponse =
                        when {
                            request.path == "/api/v1/auth/mobile/refresh" -> {
                                refreshStarted.countDown()
                                check(releaseRefresh.await(10, TimeUnit.SECONDS))
                                response(identity(access = "access-b", refresh = "refresh-b"))
                            }
                            request.path == "/api/v1/auth/mobile/logout" -> response("{}")
                            request.getHeader("Authorization") == "Bearer access-a" -> response("{}", 401)
                            else -> response("{\"id\":\"product-a\",\"description\":\"Iogurte\",\"active\":true}")
                        }
                }
            val lookup = async { runCatching { adapters.inventory.lookup("00123") } }
            assertTrue(withContext(Dispatchers.IO) { refreshStarted.await(10, TimeUnit.SECONDS) })
            val logout = async(start = CoroutineStart.UNDISPATCHED) { adapters.session.logout() }
            assertFalse(logout.isCompleted)
            releaseRefresh.countDown()
            logout.await()
            lookup.await()
            assertNull(adapters.session.session.value)
            assertNull(vault.read("refresh"))
        }

    @Test
    fun `inventory keeps long totals and recount state from generated contract`() =
        runBlocking {
            login()
            server.enqueue(
                response(
                    """{"product":{"id":"product-a","description":"Iogurte","active":true,"photoUrl":null},"trackingStatus":"TRACKED","lastCountAt":null,"projectedAt":null,"inputRevision":9,"appliedInputRevision":8,"projectionRevision":4,"stale":true,"countWindowQuantity":3,"records":[{"id":"record-a","expiresOn":"2027-03-15","lotCode":null,"quantity":1000000000}],"totalQuantity":3000000000}""",
                ),
            )
            val inventory = adapters.inventory.inventory("product-a")
            assertEquals(3000000000L, inventory.totalQuantity)
            assertEquals(1000000000, inventory.records.single().quantity)
            assertEquals(3L, inventory.countWindowQuantity)
            assertTrue(inventory.stale)
            assertNull(inventory.product.photoUrl)
        }

    @Test
    fun `malformed quantities fail instead of becoming zero or overflowing`() =
        runBlocking {
            login()
            for (quantity in listOf("0.5", "2147483648")) {
                server.enqueue(
                    response(
                        """{"product":{"id":"product-a","description":"Iogurte","active":true},"trackingStatus":"TRACKED","lastCountAt":null,"projectedAt":null,"inputRevision":1,"appliedInputRevision":1,"projectionRevision":1,"stale":false,"countWindowQuantity":0,"records":[{"id":"record-a","expiresOn":"2027-03-15","quantity":$quantity}],"totalQuantity":1}""",
                    ),
                )
                assertTrue(runCatching { adapters.inventory.inventory("product-a") }.exceptionOrNull() is AppFailure)
            }
            server.enqueue(response("""{"id":"product-a","description":"Iogurte"}"""))
            assertTrue(runCatching { adapters.inventory.lookup("00123") }.exceptionOrNull() is AppFailure)
        }

    @Test
    fun `expiry list maps the store level and forwards cursor and level`() =
        runBlocking {
            login()
            server.enqueue(
                response(
                    """{"items":[{"id":"record-a","productId":"product-a","productName":"Iogurte","barcode":"0789","expiresOn":"2026-09-30","lotCode":null,"quantity":6,"daysToExpiry":2,"levelId":"urgente","levelName":"Urgente","levelColor":"#ef6c00"}],"nextCursor":"record-a"}""",
                ),
            )
            val page = adapters.inventory.expiries("prior", "urgente")
            val item = page.items.single()
            assertEquals("Urgente", item.level?.name)
            assertEquals("#ef6c00", item.level?.color)
            assertEquals("0789", item.barcode)
            assertEquals(6L, item.quantity)
            assertEquals("record-a", page.nextCursor)
            assertEquals("/api/v1/inventory/expiries?limit=50&cursor=prior&levelId=urgente", server.takeRequest().path)
        }

    @Test
    fun `lot details carry launch, sales and write-offs, and corrections send the version`() =
        runBlocking {
            login()
            server.enqueue(
                response(
                    """{"product":{"id":"product-a","description":"Iogurte","active":true},"trackingStatus":"TRACKED","lastCountAt":null,"projectedAt":null,"inputRevision":1,"appliedInputRevision":1,"projectionRevision":1,"stale":false,"countWindowQuantity":0,"records":[{"id":"record-a","expiresOn":"2027-03-15","quantity":5,"version":3,"launchedQuantity":10,"soldQuantity":4,"writtenOffQuantity":1,"status":"PENDING","origin":"APP_RECEIPT","launchedAt":"2026-10-17T13:05:00.000000Z","launchedBy":"ana","levelId":"em-dia","levelName":"Em dia","levelColor":"#2e7d32"}],"totalQuantity":5}""",
                ),
            )
            val record =
                adapters.inventory
                    .inventory("product-a")
                    .records
                    .single()
            server.takeRequest()
            assertEquals(StockRecord::class, record::class)
            assertEquals(
                listOf(10, 4, 1, 5, 3),
                listOf(record.launchedQuantity, record.soldQuantity, record.writtenOffQuantity, record.quantity, record.version),
            )
            assertEquals("ana", record.launchedBy)
            assertEquals("Em dia", record.level?.name)
            server.enqueue(response("{}"))
            adapters.inventory.writeOff(record, 2, "vencido")
            val writeOff = server.takeRequest()
            assertEquals("/api/v1/inventory/records/record-a/write-off", writeOff.path)
            assertNotNull(writeOff.getHeader("Idempotency-Key"))
            val body = writeOff.body.readUtf8()
            assertTrue(
                body,
                body.contains("\"expectedVersion\":3") && body.contains("\"quantity\":2") && body.contains("\"reason\":\"vencido\""),
            )
            server.enqueue(response("{}"))
            adapters.inventory.deleteRecord(record)
            assertEquals("/api/v1/inventory/records/record-a/delete", server.takeRequest().path)
        }

    @Test
    fun `dropped connection is retried for reads and keyed commands, never for login`() =
        runBlocking {
            login()
            // B01: a primeira tentativa de cada caminho cai sem resposta, como numa conexão parada
            // que a rede da loja já fechou; a leitura e o comando com chave tentam de novo sozinhos.
            val calls = ConcurrentHashMap<String, AtomicInteger>()
            server.dispatcher =
                object : Dispatcher() {
                    override fun dispatch(request: RecordedRequest): MockResponse {
                        val path = request.path.orEmpty()
                        val call = calls.getOrPut(path) { AtomicInteger() }.incrementAndGet()
                        return when {
                            call == 1 || path.endsWith("/login") -> MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
                            path.contains("by-barcode") -> response("""{"id":"product-a","description":"Iogurte","active":true}""")
                            else -> response("{}")
                        }
                    }
                }
            assertEquals("Iogurte", adapters.inventory.lookup("0789").description)
            adapters.inventory.receive(entry)
            assertNull(adapters.inventory.pendingCommand())
            assertEquals(2, calls["/api/v1/inventory/receipts"]?.get())
            // O login já enviado não repete: o envio é único.
            val failure = runCatching { adapters.session.login("04252011000110", "ana", "test-password") }.exceptionOrNull()
            assertNotNull(failure)
            assertEquals(1, calls["/api/v1/auth/mobile/login"]?.get())
        }

    @Test
    fun `editable count list loads detail before mapping lines`() =
        runBlocking {
            login()
            server.enqueue(
                response(
                    """{"items":[{"id":"count-a","productId":"product-a","status":"COUNTING","version":2}],"nextCursor":null}""",
                ),
            )
            server.enqueue(
                response(
                    """{"id":"count-a","productId":"product-a","status":"COUNTING","version":2,"lines":[{"id":"line-a","expiresOn":"2027-03-15","quantity":7,"lotCode":"L1"}]}""",
                ),
            )
            val count = adapters.inventory.counts("product-a").single()
            assertEquals("/api/v1/count-sessions?productId=product-a", server.takeRequest().path)
            assertEquals("/api/v1/count-sessions/count-a", server.takeRequest().path)
            assertEquals(7, count.lines.single().quantity)
            assertEquals("L1", count.lines.single().lotCode)
        }

    @Test
    fun `saving lines on the collector keeps the note written on the panel`() =
        runBlocking {
            login()
            server.enqueue(
                response(
                    """{"items":[{"id":"count-a","productId":"product-a","status":"COUNTING","version":2}],"nextCursor":null}""",
                ),
            )
            server.enqueue(
                response(
                    """{"id":"count-a","productId":"product-a","status":"COUNTING","version":2,"lines":[{"id":"line-a","expiresOn":"2027-03-15","quantity":7,"note":"caixa no depósito"}]}""",
                ),
            )
            val count = adapters.inventory.counts("product-a").single()
            server.takeRequest()
            server.takeRequest()
            server.enqueue(
                response(
                    """{"id":"count-a","productId":"product-a","status":"COUNTING","version":3,"lines":[{"id":"line-a","expiresOn":"2027-03-15","quantity":7,"note":"caixa no depósito"}]}""",
                ),
            )
            adapters.inventory.replaceLines(count, count.lines)
            val body = server.takeRequest().body.readUtf8()
            assertTrue(body, body.contains("\"note\":\"caixa no depósito\""))
        }

    @Test
    fun `missing lines in editable count detail cannot become an empty count`() =
        runBlocking {
            login()
            server.enqueue(
                response(
                    """{"items":[{"id":"count-a","productId":"product-a","status":"COUNTING","version":2}],"nextCursor":null}""",
                ),
            )
            server.enqueue(response("""{"id":"count-a","productId":"product-a","status":"COUNTING","version":2}"""))
            assertTrue(runCatching { adapters.inventory.counts("product-a") }.exceptionOrNull() is AppFailure)
        }

    @Test
    fun `restricted login accepts omitted refresh and normal login rejects it`() =
        runBlocking {
            vault.write("refresh", "previous-token")
            val restricted = identity(temporary = true).replace("\"refreshToken\":\"refresh-a\",", "")
            server.enqueue(response(restricted))
            adapters.session.login("04252011000110", "ana", "temporary-password")
            assertTrue(checkNotNull(adapters.session.session.value).mustChangePassword)
            assertNull(vault.read("refresh"))
            server.enqueue(response(identity().replace("\"refreshToken\":\"refresh-a\",", "")))
            val failure = runCatching { adapters.session.login("04252011000110", "ana", "password") }.exceptionOrNull()
            assertTrue(failure is AppFailure)
            assertNull(vault.read("refresh"))
        }

    @Test
    fun `pending command belongs to original store and user`() =
        runBlocking {
            login()
            server.enqueue(response("{}", 503))
            runCatching { adapters.inventory.receive(entry) }
            server.takeRequest()
            val original = checkNotNull(adapters.inventory.pendingCommand())
            login("store-b")
            assertNull(adapters.inventory.pendingCommand())
            login("store-a")
            assertEquals(original, adapters.inventory.pendingCommand())
        }
}

private class MemoryVault : SecretVault {
    private val values = ConcurrentHashMap<String, String>()

    override fun read(name: String): String? = values[name]

    override fun write(
        name: String,
        value: String,
    ) {
        values[name] = value
    }

    override fun remove(name: String) {
        values.remove(name)
    }
}
