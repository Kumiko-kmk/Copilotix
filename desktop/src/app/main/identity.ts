import { FULL_IDENTITY, LITE_IDENTITY } from '../contract/appIdentity'

export const APP_IDENTITY = __COPILOTIX_LITE__ ? LITE_IDENTITY : FULL_IDENTITY
