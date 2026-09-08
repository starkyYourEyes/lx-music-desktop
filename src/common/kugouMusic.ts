export const KUGOU_AUTH_REQUIRED = 'KUGOU_AUTH_REQUIRED'

export const isKugouAuthError = (error: unknown): boolean => {
  const message = error instanceof Error
    ? error.message
    : typeof (error as { message?: unknown } | null)?.message == 'string'
      ? String((error as { message: string }).message)
      : ''
  return message.includes(KUGOU_AUTH_REQUIRED)
}
