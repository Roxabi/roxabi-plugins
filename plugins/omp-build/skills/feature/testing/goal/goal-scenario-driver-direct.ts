import { main } from '../../epic-driver-cli.ts'
import { Assisted, Refused, withEpicEffects } from '../../epic-driver-runtime.ts'
import { driverGh } from './goal-simulator-port.ts'

if (import.meta.main) {
  try {
    console.log(await withEpicEffects({ gh: driverGh }, () => main(process.argv.slice(2))))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const [code, tag] =
      error instanceof Assisted ? [3, 'assisted'] : error instanceof Refused ? [2, 'refused'] : [1, 'failed']
    console.error(`driver=${tag} ${message}`)
    process.exit(code)
  }
}
