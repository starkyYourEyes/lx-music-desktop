export interface ProjectIdentity {
  readonly packageName: string
  readonly displayName: string
  readonly appId: string
  readonly productName: string
  readonly userDataDirName: string
  readonly protocolScheme: string
  readonly protocolPrefix: string
  readonly protocolName: string
  readonly syncDesktopId: string
  readonly syncMobileId: string
  readonly syncAuthPrefix: string
  readonly syncConnectMessage: string
  readonly requestUserAgent: string
  readonly userApiPartition: string
  readonly tempDirectoryName: string
  readonly defaultWebdavUrl: string
  readonly backupExtension: string
  readonly allDataBackupName: string
  readonly settingBackupName: string
  readonly playlistBackupName: string
  readonly authorName: string
  readonly repositoryUrl: string
  readonly repositoryOwner: string
  readonly repositoryName: string
  readonly issuesUrl: string
  readonly releasesUrl: string
}

export const PROJECT_IDENTITY: Readonly<ProjectIdentity>
