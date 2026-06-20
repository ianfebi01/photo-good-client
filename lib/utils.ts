import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn( ...inputs: ClassValue[] ) {
  return twMerge( clsx( inputs ) )
}

/** Slugify a string for use as a frame key. */
export function slugifyKey( raw: string ): string {
  return raw
    .toLowerCase()
    .trim()
    .replace( /[^a-z0-9]+/g, "-" )
    .replace( /^-+|-+$/g, "" )
    .slice( 0, 32 )
}
