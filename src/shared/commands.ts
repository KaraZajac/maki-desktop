/**
 * Commands maki desktop puts on the PATH (age-plugin-maki, maki-minisign, maki-ssh-keygen): where
 * each is, as the Connections page shows it.
 *
 * No Node or DOM imports: this runs in the renderer and in tests.
 */
export interface CommandStatus {
  /** installed, and starting this copy of maki desktop */
  installed: boolean
  path: string
  /** whether its folder is on the PATH, where the programs that run it look */
  onPath: boolean
}
