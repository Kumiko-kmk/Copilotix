export interface AppIdentity {
  readonly appId: string
  readonly productName: string
  readonly executableName: string
  readonly userDataFolder: string
  readonly credentialService: string
  readonly documentsFolder: string
  readonly installGuid: string
  readonly releaseDirectory: string
}

export const FULL_IDENTITY: AppIdentity
export const LITE_IDENTITY: AppIdentity & { readonly version: string }
