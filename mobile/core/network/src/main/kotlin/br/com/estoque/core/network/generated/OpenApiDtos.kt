// Generated from contracts/openapi.json. Run pnpm contracts:generate. Do not edit.
package br.com.estoque.core.network.generated

import kotlinx.serialization.Serializable

@Serializable
internal data class ApiCountLine(
    val id: String,
    val expiresOn: String,
    val lotCode: String? = null,
    val quantity: Long,
    val note: String? = null,
)

@Serializable
internal data class ApiCountSession(
    val id: String,
    val productId: String,
    val productName: String? = null,
    val status: ApiCountSessionStatus,
    val version: Long,
    val lines: List<ApiCountLine>? = null,
    val startedAt: String? = null,
    val cutoffAt: String? = null,
    val createdAt: String? = null,
)

@Serializable
internal enum class ApiCountSessionStatus {
    COUNTING,
    CONFIRMED,
    CANCELLED,
}

@Serializable
internal data class ApiExpiryItem(
    val id: String,
    val productId: String,
    val productName: String,
    val barcode: String? = null,
    val expiresOn: String,
    val lotCode: String? = null,
    val quantity: Long,
    val daysToExpiry: Long,
    val levelId: String?,
    val levelName: String? = null,
    val levelColor: String? = null,
    val forecastLeftover: Long? = null,
)

@Serializable
internal data class ApiExpiryLevelSummary(
    val levelId: String?,
    val name: String,
    val color: String,
    val minDays: Long?,
    val maxDays: Long?,
    val notify: Boolean,
    val lots: Long,
    val units: Long,
    val value: Double? = null,
)

@Serializable
internal data class ApiExpirySummary(
    val items: List<ApiExpiryLevelSummary>,
)

@Serializable
internal data class ApiHistoryItem(
    val id: String,
    val type: ApiHistoryItemType,
    val quantity: Long?,
    val occurredAt: String,
    val recordId: String? = null,
    val expiresOn: String? = null,
    val previousExpiresOn: String? = null,
    val previousQuantity: Long? = null,
    val reason: String? = null,
    val actorName: String? = null,
    val allocatedQuantity: Long? = null,
)

@Serializable
internal enum class ApiHistoryItemType {
    SALE,
    SCRAP,
    APP_RECEIPT,
    RETURN_RECEIPT,
    VOID_MOVEMENT,
    MANUAL_WRITE_OFF,
    RECORD_EDIT,
    RECORD_DELETE,
}

@Serializable
internal data class ApiInventoryDetail(
    val product: ApiProduct,
    val trackingStatus: ApiInventoryDetailTrackingStatus,
    val lastCountAt: String?,
    val projectedAt: String?,
    val inputRevision: Long,
    val appliedInputRevision: Long,
    val projectionRevision: Long,
    val stale: Boolean,
    val countWindowQuantity: Long,
    val records: List<ApiStockRecord>,
    val totalQuantity: Long,
    val dailySales: Double? = null,
    val salesHistoryDays: Long? = null,
)

@Serializable
internal enum class ApiInventoryDetailTrackingStatus {
    TRACKED,
    UNTRACKED,
}

@Serializable
internal data class ApiInventoryItem(
    val productId: String,
    val productName: String,
    val barcode: String?,
    val trackingStatus: ApiInventoryItemTrackingStatus,
    val estimatedQuantity: Long,
    val nearestExpiry: String?,
    val stale: Boolean,
    val category: String? = null,
    val salePrice: Double? = null,
    val countActive: Boolean? = null,
)

@Serializable
internal enum class ApiInventoryItemTrackingStatus {
    TRACKED,
    UNTRACKED,
}

@Serializable
internal data class ApiMobileSession(
    val accessToken: String,
    val refreshToken: String? = null,
    val user: ApiUser,
    val store: ApiStore,
    val mustChangePassword: Boolean? = null,
)

@Serializable
internal data class ApiPageCountSession(
    val items: List<ApiCountSession>,
    val nextCursor: String?,
)

@Serializable
internal data class ApiPageExpiryItem(
    val items: List<ApiExpiryItem>,
    val nextCursor: String?,
)

@Serializable
internal data class ApiPageHistoryItem(
    val items: List<ApiHistoryItem>,
    val nextCursor: String?,
)

@Serializable
internal data class ApiPageInventoryItem(
    val items: List<ApiInventoryItem>,
    val nextCursor: String?,
)

@Serializable
internal data class ApiProduct(
    val id: String,
    val description: String,
    val active: Boolean,
    val photoUrl: String? = null,
    val barcodes: List<String>? = null,
)

@Serializable
internal data class ApiPushConfig(
    val allowed: Boolean,
    val webPushPublicKey: String?,
    val fcmProjectId: String?,
    val fcmAppId: String?,
    val fcmApiKey: String?,
    val fcmSenderId: String?,
)

@Serializable
internal data class ApiStockRecord(
    val id: String,
    val expiresOn: String,
    val lotCode: String? = null,
    val note: String? = null,
    val quantity: Long,
    val version: Long? = null,
    val origin: ApiStockRecordOrigin? = null,
    val launchedQuantity: Long? = null,
    val soldQuantity: Long? = null,
    val writtenOffQuantity: Long? = null,
    val status: ApiStockRecordStatus? = null,
    val launchedAt: String? = null,
    val launchedBy: String? = null,
    val deletedAt: String? = null,
    val deletedBy: String? = null,
    val daysToExpiry: Long? = null,
    val levelId: String? = null,
    val levelName: String? = null,
    val levelColor: String? = null,
    val forecastLeftover: Long? = null,
)

@Serializable
internal enum class ApiStockRecordOrigin {
    COUNT,
    APP_RECEIPT,
    RETURN_RECEIPT,
}

@Serializable
internal enum class ApiStockRecordStatus {
    PENDING,
    AUTOMATIC,
    MANUAL,
    BOTH,
    EMPTY,
    DELETED,
    REPLACED,
}

@Serializable
internal data class ApiStore(
    val id: String,
    val name: String,
    val cnpj: String,
)

@Serializable
internal data class ApiUser(
    val id: String,
    val username: String,
    val role: ApiUserRole,
    val storeId: String,
    val active: Boolean? = null,
    val version: Long? = null,
    val mustChangePassword: Boolean? = null,
)

@Serializable
internal enum class ApiUserRole {
    OWNER,
    MANAGER,
    OPERATOR,
}
