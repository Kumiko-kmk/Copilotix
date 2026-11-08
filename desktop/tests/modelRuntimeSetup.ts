import { documentModels } from '@features/document/utility'
import { beforeEach } from 'vitest'
import { configureModelConnections, sharedModelRuntime } from '@platform/models/runtime/modelRuntime'
beforeEach(() => { documentModels.sourceFiles = undefined; sharedModelRuntime.clear(); configureModelConnections() })
