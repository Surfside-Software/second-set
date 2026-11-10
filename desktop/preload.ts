import { contextBridge, ipcRenderer, webUtils } from "electron";
import { exposeRpcBridge } from "electron-effect-rpc/preload";

exposeRpcBridge({ endpoints: ["default"] });

contextBridge.exposeInMainWorld("secondSetFiles", {
  stageDrop: (file: File) =>
    ipcRenderer.invoke("second-set:stage-pdf", webUtils.getPathForFile(file)),
});
