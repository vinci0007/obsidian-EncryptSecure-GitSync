declare module "electron" {
  export const shell: {
    openExternal(target: string): Promise<void>;
    openPath(target: string): Promise<string>;
  };
  export const dialog: {
    showOpenDialog(options: {
      title?: string;
      defaultPath?: string;
      properties?: Array<"openFile" | "openDirectory" | "multiSelections">;
      filters?: Array<{ name: string; extensions: string[] }>;
    }): Promise<{ canceled: boolean; filePaths: string[] }>;
  };
  export const session: {
    defaultSession?: {
      setProxy(config: { proxyRules?: string; proxyBypassRules?: string }): Promise<void>;
    };
  };
  export const remote: {
    dialog?: typeof dialog;
    session?: typeof session;
  };
}
