// The box's label, set by the server in a <meta name="foray-label"> when
// ~/.foray/config.json has one (server/boxConfig.ts). Absent otherwise.

export function boxLabel(): string | null {
  if (typeof document === 'undefined') return null
  const content = document.querySelector('meta[name="foray-label"]')?.getAttribute('content')?.trim()
  return content || null
}
