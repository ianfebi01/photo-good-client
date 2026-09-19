import { cp, mkdir, rm } from 'node:fs/promises'

const standalone = '.next/standalone'

await mkdir( `${standalone}/.next`, { recursive: true } )
await cp( '.next/static', `${standalone}/.next/static`, { recursive: true, force: true } )
await rm( `${standalone}/public`, { recursive: true, force: true } )
await cp( 'public', `${standalone}/public`, { recursive: true, force: true } )
await cp( '.env.local', `${standalone}/.env.local`, { force: true } )