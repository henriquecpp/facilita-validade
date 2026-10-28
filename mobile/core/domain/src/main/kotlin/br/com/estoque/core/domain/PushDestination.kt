package br.com.estoque.core.domain

/** Destinos internos compartilhados com os links dos avisos web; não abrem endereços externos. */
sealed interface PushDestination {
    data class Product(
        val id: String,
    ) : PushDestination

    data class Expiries(
        val levelId: String? = null,
    ) : PushDestination

    companion object {
        private const val UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
        private val product = Regex("^/products/($UUID)$")
        private val level = Regex("^/expiries\\?(?:nivel|levelId)=($UUID)$")

        fun parse(url: String): PushDestination? {
            product.matchEntire(url)?.let { return Product(it.groupValues[1]) }
            level.matchEntire(url)?.let { return Expiries(it.groupValues[1]) }
            return if (url == "/alerts" || url == "/expiries") Expiries() else null
        }
    }
}
