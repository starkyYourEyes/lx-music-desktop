declare namespace LX {
  namespace ConfigFile {
    interface UserListInfoBackup extends LX.List.UserListInfoFull {
      group?: LX.List.UserListGroup
    }

    type ListInfoBackup =
      | LX.List.MyDefaultListInfoFull
      | LX.List.MyLoveListInfoFull
      | UserListInfoBackup

    interface MyListInfoPart {
      type: 'playListPart_v2'
      data: ListInfoBackup & { profile?: LX.List.UserListProfile }
    }

  }
}
