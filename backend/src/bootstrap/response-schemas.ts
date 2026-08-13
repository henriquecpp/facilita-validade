/** Public response schemas. Keep contract tests alongside changes to serializers. */
import type { OpenAPIObject, SchemaObject } from '@nestjs/swagger';
const text: SchemaObject = { type: 'string' };
const number: SchemaObject = { type: 'integer', format: 'int64' };
const boolean: SchemaObject = { type: 'boolean' };
const nullableText: SchemaObject = { type: 'string', nullable: true };
const nullableNumber: SchemaObject = { type: 'integer', format: 'int64', nullable: true };
/** Valor em R$, com centavos. */
const money: SchemaObject = { type: 'number', format: 'double' };
const nullableMoney: SchemaObject = { type: 'number', format: 'double', nullable: true };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const array = (name: string): SchemaObject => ({ type: 'array', items: ref(name) });
const object = (
  properties: Record<string, SchemaObject | { $ref: string }>,
  required = Object.keys(properties),
): SchemaObject => ({ type: 'object', properties, required });
const enumText = (values: string[]): SchemaObject => ({ type: 'string', enum: values });
export function describeResponses(document: OpenAPIObject) {
  const schemas: Record<string, SchemaObject> = {
    User: object(
      {
        id: text,
        username: text,
        role: enumText(['OWNER', 'MANAGER', 'OPERATOR']),
        storeId: text,
        active: boolean,
        version: number,
        mustChangePassword: boolean,
      },
      ['id', 'username', 'role', 'storeId'],
    ),
    Store: object({ id: text, name: text, cnpj: text }),
    DeviceSession: object({
      id: text,
      userId: text,
      username: text,
      startedAt: text,
      lastActiveAt: text,
    }),
    RevokedDeviceSession: object({ id: text }),
    DevicePairing: object({
      code: text,
      expiresAt: text,
      user: object({ id: text, username: text }),
    }),
    Session: object(
      { accessToken: text, user: ref('User'), store: ref('Store'), mustChangePassword: boolean },
      ['accessToken', 'user', 'store'],
    ),
    MobileSession: object(
      {
        accessToken: text,
        refreshToken: text,
        user: ref('User'),
        store: ref('Store'),
        mustChangePassword: boolean,
      },
      ['accessToken', 'user', 'store'],
    ),
    Product: object(
      {
        id: text,
        description: text,
        active: boolean,
        photoUrl: nullableText,
        barcodes: { type: 'array', items: text },
      },
      ['id', 'description', 'active'],
    ),
    InventoryItem: object(
      {
        productId: text,
        productName: text,
        barcode: nullableText,
        trackingStatus: enumText(['TRACKED', 'UNTRACKED']),
        estimatedQuantity: number,
        nearestExpiry: nullableText,
        stale: boolean,
        category: nullableText,
        salePrice: nullableMoney,
        countActive: boolean,
      },
      [
        'productId',
        'productName',
        'barcode',
        'trackingStatus',
        'estimatedQuantity',
        'nearestExpiry',
        'stale',
      ],
    ),
    ProductCategory: object({ code: text, products: number }),
    ProductCategories: object({ items: array('ProductCategory') }),
    ExpiryItem: object(
      {
        id: text,
        productId: text,
        productName: text,
        barcode: nullableText,
        expiresOn: text,
        lotCode: nullableText,
        quantity: number,
        daysToExpiry: number,
        levelId: nullableText,
        levelName: nullableText,
        levelColor: nullableText,
        // Sobra prevista na validade pela média de vendas: 0 vende a tempo; nula sem previsão.
        forecastLeftover: nullableNumber,
      },
      ['id', 'productId', 'productName', 'expiresOn', 'quantity', 'daysToExpiry', 'levelId'],
    ),
    // Faixa sem nível (lotes fora de todas as faixas): levelId nulo, só quando há lote nela.
    ExpiryLevelSummary: object(
      {
        levelId: nullableText,
        name: text,
        color: text,
        minDays: nullableNumber,
        maxDays: nullableNumber,
        notify: boolean,
        lots: number,
        units: number,
        value: money,
      },
      ['levelId', 'name', 'color', 'minDays', 'maxDays', 'notify', 'lots', 'units'],
    ),
    ExpirySummary: object({ items: array('ExpiryLevelSummary') }),
    ExpiryLevel: object(
      {
        id: text,
        name: text,
        minDays: nullableNumber,
        maxDays: nullableNumber,
        color: text,
        notify: boolean,
      },
      ['id', 'name', 'minDays', 'maxDays', 'color', 'notify'],
    ),
    ExpiryLevels: object({ version: number, items: array('ExpiryLevel') }),
    // Status: PENDING tem saldo; AUTOMATIC, as vendas zeraram; MANUAL, uma baixa manual zerou;
    // BOTH, zerou com os dois tipos de baixa; EMPTY, sem saldo e sem baixa; DELETED, excluído;
    // REPLACED, substituído pela contagem que abriu a época seguinte.
    StockRecord: object(
      {
        id: text,
        expiresOn: text,
        lotCode: nullableText,
        note: nullableText,
        quantity: number,
        version: number,
        origin: enumText(['COUNT', 'APP_RECEIPT', 'RETURN_RECEIPT']),
        launchedQuantity: number,
        soldQuantity: number,
        writtenOffQuantity: number,
        status: enumText([
          'PENDING',
          'AUTOMATIC',
          'MANUAL',
          'BOTH',
          'EMPTY',
          'DELETED',
          'REPLACED',
        ]),
        launchedAt: text,
        launchedBy: nullableText,
        deletedAt: nullableText,
        deletedBy: nullableText,
        daysToExpiry: number,
        levelId: nullableText,
        levelName: nullableText,
        levelColor: nullableText,
        forecastLeftover: nullableNumber,
      },
      ['id', 'expiresOn', 'quantity'],
    ),
    // dailySales e salesHistoryDays vieram depois: opcionais para o aplicativo novo com
    // servidor antigo. Nulos quando o produto ainda não tem histórico para a previsão.
    InventoryDetail: object(
      {
        product: ref('Product'),
        trackingStatus: enumText(['TRACKED', 'UNTRACKED']),
        lastCountAt: nullableText,
        projectedAt: nullableText,
        inputRevision: number,
        appliedInputRevision: number,
        projectionRevision: number,
        stale: boolean,
        countWindowQuantity: number,
        records: array('StockRecord'),
        totalQuantity: number,
        dailySales: nullableMoney,
        salesHistoryDays: nullableNumber,
      },
      [
        'product',
        'trackingStatus',
        'lastCountAt',
        'projectedAt',
        'inputRevision',
        'appliedInputRevision',
        'projectionRevision',
        'stale',
        'countWindowQuantity',
        'records',
        'totalQuantity',
      ],
    ),
    CountLine: object(
      { id: text, expiresOn: text, lotCode: nullableText, quantity: number, note: nullableText },
      ['id', 'expiresOn', 'quantity'],
    ),
    CountSession: object(
      {
        id: text,
        productId: text,
        productName: text,
        status: enumText(['COUNTING', 'CONFIRMED', 'CANCELLED']),
        version: number,
        lines: array('CountLine'),
        startedAt: nullableText,
        cutoffAt: nullableText,
        createdAt: text,
      },
      ['id', 'productId', 'status', 'version'],
    ),
    Notification: object(
      {
        id: text,
        title: text,
        message: text,
        type: enumText(['EXPIRY', 'DEPLETED']),
        levelId: nullableText,
        levelName: nullableText,
        levelColor: nullableText,
        productId: text,
        productName: text,
        expiresOn: text,
        quantity: number,
        readAt: nullableText,
        createdAt: text,
      },
      ['id', 'title', 'type', 'createdAt'],
    ),
    DashboardLevel: object(
      { levelId: nullableText, name: text, color: text, lots: number, units: number, value: money },
      ['levelId', 'name', 'color', 'lots', 'units', 'value'],
    ),
    DashboardWeek: object({
      fromDays: number,
      toDays: number,
      lots: number,
      units: number,
      value: money,
    }),
    // Os campos de vendas e de valores vieram depois: opcionais para o aplicativo novo com
    // servidor antigo. Valores em R$ pelo preço de venda; lote sem preço conta zero.
    Dashboard: object(
      {
        trackedProducts: number,
        atRiskRecords: number,
        // Dos lotes a vencer, os que a média de vendas prevê vender antes da validade.
        sellingInTimeRecords: number,
        expiredRecords: number,
        openIssues: number,
        unreadNotifications: number,
        lastImportAt: nullableText,
        pendingImports: number,
        salesThroughAt: nullableText,
        salesDelayed: boolean,
        stockValue: money,
        expiringValue: money,
        expiredValue: money,
        unpricedLots: number,
        levels: array('DashboardLevel'),
        upcomingWeeks: array('DashboardWeek'),
      },
      [
        'trackedProducts',
        'atRiskRecords',
        'expiredRecords',
        'openIssues',
        'unreadNotifications',
        'lastImportAt',
        'pendingImports',
      ],
    ),
    ImportError: object({ externalEventId: text, message: text }, ['message']),
    ImportBatch: object(
      {
        id: text,
        externalBatchId: text,
        status: text,
        createdAt: text,
        processedCount: number,
        eventCount: number,
        issuesCount: number,
        errors: array('ImportError'),
      },
      ['id', 'externalBatchId', 'status', 'createdAt'],
    ),
    StoreSettings: object(
      {
        version: number,
        timezone: text,
        alertEmails: { type: 'array', items: text },
        digestHour: number,
        salesForecastAlerts: boolean,
        emailAvailable: boolean,
        lastDigestDate: nullableText,
        lastDigestStatus: { ...enumText(['SENDING', 'SENT', 'SKIPPED', 'FAILED']), nullable: true },
        lastDigestAt: nullableText,
        lastDigestError: nullableText,
      },
      ['version', 'timezone', 'alertEmails', 'digestHour', 'emailAvailable'],
    ),
    TestEmailResult: object({ recipients: number }),
    // Com recordId, allocatedQuantity é o que aquele movimento tirou do lote.
    HistoryItem: object(
      {
        id: text,
        type: enumText([
          'SALE',
          'SCRAP',
          'APP_RECEIPT',
          'RETURN_RECEIPT',
          'VOID_MOVEMENT',
          'MANUAL_WRITE_OFF',
          'RECORD_EDIT',
          'RECORD_DELETE',
        ]),
        quantity: nullableNumber,
        occurredAt: text,
        recordId: nullableText,
        expiresOn: nullableText,
        previousExpiresOn: nullableText,
        previousQuantity: nullableNumber,
        reason: nullableText,
        actorName: nullableText,
        allocatedQuantity: nullableNumber,
      },
      ['id', 'type', 'quantity', 'occurredAt'],
    ),
    Issue: object(
      {
        id: text,
        type: text,
        productId: text,
        productName: text,
        quantity: { type: 'integer', format: 'int64', nullable: true },
        message: text,
        status: text,
        createdAt: text,
        movementId: text,
        movementType: text,
      },
      ['id', 'type', 'status', 'createdAt'],
    ),
    LevelPushPreference: object({
      levelId: text,
      immediate: boolean,
      intervalHours: nullableNumber,
      dailyTime: nullableText,
    }),
    PushPreferences: object({
      version: number,
      dailyDigestEnabled: boolean,
      depletedEnabled: boolean,
      levels: array('LevelPushPreference'),
    }),
    AuditDetail: object(
      {
        quantity: number,
        reason: text,
        expiresOn: text,
        previousQuantity: number,
        previousExpiresOn: text,
      },
      [],
    ),
    AuditEvent: object(
      {
        id: text,
        action: text,
        actorId: nullableText,
        entityId: nullableText,
        createdAt: text,
        details: ref('AuditDetail'),
      },
      ['id', 'action', 'createdAt'],
    ),
    IntegrationKey: object({
      id: text,
      scopes: { type: 'array', items: text },
      revokedAt: nullableText,
    }),
    IntegrationConnection: object(
      { id: text, name: text, active: boolean, keys: array('IntegrationKey') },
      ['id', 'name', 'active'],
    ),
    ReceivedBatch: object({ id: text, status: text }),
    PagonetSource: object({
      configured: boolean,
      active: boolean,
      cnpj: text,
      available: boolean,
      catalogSyncedAt: nullableText,
      catalogProducts: { type: 'integer', format: 'int64', nullable: true },
      salesSyncedAt: nullableText,
      salesThrough: nullableText,
      salesDelayed: boolean,
      lastError: nullableText,
      lastErrorAt: nullableText,
      syncRequestedAt: nullableText,
      syncRunning: boolean,
      syncStartsAt: nullableText,
    }),
    PushConfig: object({
      allowed: boolean,
      webPushPublicKey: nullableText,
      fcmProjectId: nullableText,
      fcmAppId: nullableText,
      fcmApiKey: nullableText,
      fcmSenderId: nullableText,
    }),
    PushSubscription: object({ id: text, kind: enumText(['WEB', 'FCM']) }),
    PushRemoved: object({ removed: number }),
    PushTest: object({ sent: number, targets: number }),
    // Painel da plataforma (super admin). Objetos anuláveis vão inline: `$ref` não aceita
    // `nullable` ao lado no OpenAPI 3.0.
    PlatformAdmin: object({ id: text, username: text, mustChangePassword: boolean }),
    PlatformStore: object({
      id: text,
      cnpj: text,
      name: text,
      timezone: text,
      active: boolean,
      createdAt: text,
      activeUsers: number,
      owners: { type: 'array', items: text },
      pagonet: {
        ...object({ active: boolean, salesThrough: nullableText, lastError: nullableText }),
        nullable: true,
      },
      lastImportAt: nullableText,
    }),
    PlatformStoreUser: object({
      id: text,
      username: text,
      role: enumText(['OWNER', 'MANAGER', 'OPERATOR']),
      active: boolean,
      mustChangePassword: boolean,
    }),
    PlatformStoreDetail: object({
      id: text,
      cnpj: text,
      name: text,
      timezone: text,
      active: boolean,
      createdAt: text,
      activeUsers: number,
      owners: { type: 'array', items: text },
      lastImportAt: nullableText,
      users: array('PlatformStoreUser'),
      pagonet: {
        ...object({
          active: boolean,
          catalogSyncedAt: nullableText,
          catalogProducts: { type: 'integer', format: 'int64', nullable: true },
          salesSyncedAt: nullableText,
          salesThrough: nullableText,
          lastError: nullableText,
          lastErrorAt: nullableText,
        }),
        nullable: true,
      },
    }),
    CreatedStore: object({
      store: ref('PlatformStoreDetail'),
      owner: object({ id: text, username: text, temporaryPassword: text }),
    }),
    OwnerAccess: object({ username: text, resetToken: text, expiresAt: text }),
    PlatformEvent: object({
      id: text,
      createdAt: text,
      action: text,
      operator: nullableText,
      store: { ...object({ id: text, name: text }), nullable: true },
      detail: object({ reason: text, username: text, cnpj: text }, []),
    }),
    PlatformPagonet: object({ configured: boolean }),
    PlatformPagonetCheck: object({
      configured: boolean,
      ok: boolean,
      userName: nullableText,
      message: nullableText,
    }),
    LoggedOut: object({ loggedOut: boolean }),
    ApiError: object(
      { code: text, message: text, fieldErrors: { type: 'array', items: text }, requestId: text },
      ['code', 'message', 'requestId'],
    ),
  };
  for (const name of [
    'Product',
    'InventoryItem',
    'ExpiryItem',
    'StockRecord',
    'CountSession',
    'Notification',
    'ImportBatch',
    'HistoryItem',
    'Issue',
    'AuditEvent',
    'IntegrationConnection',
    'User',
    'DeviceSession',
    'PlatformStore',
    'PlatformEvent',
  ])
    schemas[`Page${name}`] = object({ items: array(name), nextCursor: nullableText });
  document.components ??= {};
  document.components.schemas = { ...document.components.schemas, ...schemas };
  const routes: Record<string, string> = {
    'GET /products': 'PageProduct',
    'GET /products/by-barcode/{barcode}': 'Product',
    'GET /products/{id}': 'Product',
    'GET /inventory': 'PageInventoryItem',
    'GET /inventory/expiries': 'PageExpiryItem',
    'GET /inventory/expiries/summary': 'ExpirySummary',
    'GET /products/categories': 'ProductCategories',
    'GET /inventory/products/{id}': 'InventoryDetail',
    'POST /inventory/receipts': 'InventoryDetail',
    'GET /inventory/products/{id}/history': 'PageHistoryItem',
    'GET /inventory/products/{id}/closed-records': 'PageStockRecord',
    'POST /inventory/records/{id}/write-off': 'InventoryDetail',
    'POST /inventory/records/{id}/delete': 'InventoryDetail',
    'PATCH /inventory/records/{id}': 'InventoryDetail',
    'GET /count-sessions': 'PageCountSession',
    'POST /count-sessions': 'CountSession',
    'GET /count-sessions/{id}': 'CountSession',
    'PUT /count-sessions/{id}/lines': 'CountSession',
    'POST /count-sessions/{id}/confirm': 'CountSession',
    'POST /count-sessions/{id}/cancel': 'CountSession',
    'GET /notifications': 'PageNotification',
    'GET /dashboard/summary': 'Dashboard',
    'GET /store': 'Store',
    'GET /store/settings': 'StoreSettings',
    'PATCH /store/settings': 'StoreSettings',
    'GET /store/expiry-levels': 'ExpiryLevels',
    'PUT /store/expiry-levels': 'ExpiryLevels',
    'GET /push/config': 'PushConfig',
    'GET /push/preferences': 'PushPreferences',
    'PUT /push/preferences': 'PushPreferences',
    'POST /push/subscriptions': 'PushSubscription',
    'POST /push/subscriptions/remove': 'PushRemoved',
    'POST /push/test': 'PushTest',
    'POST /store/settings/test-email': 'TestEmailResult',
    'GET /imports': 'PageImportBatch',
    'GET /imports/{id}': 'ImportBatch',
    'GET /reconciliation-issues': 'PageIssue',
    'GET /audit-events': 'PageAuditEvent',
    'GET /users': 'PageUser',
    'POST /users': 'User',
    'PATCH /users/{id}': 'User',
    'GET /integration-connections': 'PageIntegrationConnection',
    'POST /integration-connections': 'IntegrationConnection',
    'GET /pagonet-source': 'PagonetSource',
    'POST /pagonet-source': 'PagonetSource',
    'POST /pagonet-source/sync': 'PagonetSource',
    'POST /integrations/catalog-batches': 'ReceivedBatch',
    'POST /integrations/movement-batches': 'ReceivedBatch',
    'POST /auth/web/login': 'Session',
    'POST /auth/web/refresh': 'Session',
    'POST /auth/mobile/login': 'MobileSession',
    'POST /auth/mobile/refresh': 'MobileSession',
    'POST /auth/mobile/pair': 'MobileSession',
    'POST /device-pairings': 'DevicePairing',
    'GET /device-sessions': 'PageDeviceSession',
    'POST /device-sessions/{id}/revoke': 'RevokedDeviceSession',
    'POST /platform/auth/login': 'PlatformAdmin',
    'POST /platform/auth/logout': 'LoggedOut',
    'GET /platform/me': 'PlatformAdmin',
    'POST /platform/auth/change-password': 'PlatformAdmin',
    'GET /platform/stores': 'PagePlatformStore',
    'POST /platform/stores': 'CreatedStore',
    'GET /platform/stores/{id}': 'PlatformStoreDetail',
    'POST /platform/stores/{id}/suspend': 'PlatformStoreDetail',
    'POST /platform/stores/{id}/reactivate': 'PlatformStoreDetail',
    'POST /platform/stores/{id}/owner-access': 'OwnerAccess',
    'GET /platform/history': 'PagePlatformEvent',
    'GET /platform/pagonet': 'PlatformPagonet',
    'POST /platform/pagonet/check': 'PlatformPagonetCheck',
  };
  for (const [path, item] of Object.entries(document.paths))
    for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
      const operation = item?.[method];
      if (!operation) continue;
      const schema = routes[`${method.toUpperCase()} ${path.replace('/api/v1', '')}`];
      if (schema) {
        const status = Object.keys(operation.responses).find((key) => key.startsWith('2')) ?? '200';
        operation.responses[status] = {
          description: 'Operação concluída; importações 202 indicam recebimento.',
          content: { 'application/json': { schema: ref(schema) } },
        };
      }
      for (const code of ['400', '401', '403', '404', '409', '422', '429', '503'])
        operation.responses[code] = {
          description: 'Erro estruturado.',
          content: { 'application/json': { schema: ref('ApiError') } },
        };
      if (
        ['post', 'put', 'patch', 'delete'].includes(method) &&
        !path.includes('/auth/') &&
        !path.includes('/users') &&
        !path.includes('/integration-keys') &&
        !path.includes('/device-sessions') &&
        !path.includes('/integrations/') &&
        // Inscrição de push é idempotente pelo próprio endereço do aparelho.
        !path.includes('/push/') &&
        // Protocolo próprio: respostas com segredo (senha provisória, link de acesso) não
        // podem ficar em recibos, e suspender ou reativar já é idempotente.
        !path.includes('/platform/')
      )
        operation.parameters = [
          ...(operation.parameters ?? []),
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
        ];
    }
  return document;
}
