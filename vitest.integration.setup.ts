import { inject } from 'vitest'

// Fixtures and their child processes can use this without depending on Vitest.
process.env.OMP_TEST_GH_SIMULATOR_PATH = inject('ompTestGhSimulatorPath')
