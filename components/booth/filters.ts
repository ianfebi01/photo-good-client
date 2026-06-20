export const filtersList = [
  { name : 'none', label : 'Normal' },
  { name : 'grayscale', label : 'B&W' },
  { name : 'sepia', label : 'Sepia' },
  { name : 'warm', label : 'Warm' },
  { name : 'cool', label : 'Cool' },
  { name : 'vintage', label : 'Vintage' },
]

export function getCSSFilter( filter: string ) {
  if ( filter === 'grayscale' ) return 'grayscale(1)'
  if ( filter === 'sepia' ) return 'sepia(0.8)'
  if ( filter === 'warm' ) return 'sepia(0.15) saturate(1.2) hue-rotate(-10deg)'
  if ( filter === 'cool' ) return 'saturate(0.9) hue-rotate(10deg) brightness(1.02)'
  if ( filter === 'vintage' ) return 'sepia(0.25) saturate(0.8) contrast(1.1) brightness(1.05)'

  return 'none'
}
