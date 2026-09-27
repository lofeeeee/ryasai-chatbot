export interface ApiKeyRow {
  id: string
  isActive: boolean
  label: string
  maskedKey: string
  requestLimitPerMinute: number | null
  dailyRequestLimit: number | null
  lastUsedAt: string | null
  revokedAt: string | null
  createdAt: string
  /**
   * Source scope. Empty arrays mean "all sources" — every key created before scoping existed.
   * Optional because the list endpoint may not always return them; `readKeyScope` treats absent as
   * unrestricted, so a missing field cannot be misread as "no access".
   */
  allowedIntegrationIds?: string[]
  allowedDocumentIds?: string[]
  allowedTools?: string[]
}

export interface RequestLogRow {
  id: string
  endpoint: string
  status: number
  latencyMs: number | null
  errorMessage: string | null
  createdAt: string
}

export interface TestResponse {
  ok: boolean
  statusCode: number
  latencyMs: number
  headers: Record<string, string>
  body: string
  error?: string
}

export interface KvPair {
  id: number
  key: string
  value: string
}
