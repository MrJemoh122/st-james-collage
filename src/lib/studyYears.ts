export function parseStudyYears(value: string): number[] | null {
  const trimmed = value.trim()
  if (!trimmed) return []

  const parts = trimmed.split(',').map((part) => part.trim())
  if (parts.some((part) => !/^\d+$/.test(part))) return null

  const years = parts.map(Number)
  if (
    years.some((year) => year < 1 || year > 20)
    || new Set(years).size !== years.length
  ) return null

  return years.sort((left, right) => left - right)
}
