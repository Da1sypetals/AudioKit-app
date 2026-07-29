const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('audiokit', {
  getPaths: () => ipcRenderer.invoke('paths:get'),
  pickAudio: (options) => ipcRenderer.invoke('dialog:pick-audio', options),

  listTimbre: () => ipcRenderer.invoke('timbre:list'),
  importTimbre: (filePaths) => ipcRenderer.invoke('timbre:import', filePaths),
  deleteTimbre: (name) => ipcRenderer.invoke('timbre:delete', name),
  renameTimbre: (oldName, newStem) => ipcRenderer.invoke('timbre:rename', oldName, newStem),

  listInputs: () => ipcRenderer.invoke('input:list'),
  importInput: (filePaths) => ipcRenderer.invoke('input:import', filePaths),
  deleteInput: (name) => ipcRenderer.invoke('input:delete', name),

  listOutputs: () => ipcRenderer.invoke('outputs:list'),
  deleteOutput: (dirName) => ipcRenderer.invoke('outputs:delete', dirName),
  reveal: (filePath) => ipcRenderer.invoke('file:reveal', filePath),

  runSep: (options) => ipcRenderer.invoke('job:sep', options),
  runSvc: (options) => ipcRenderer.invoke('job:svc', options),

  onJobEvent: (callback) => {
    const listener = (_event, msg) => callback(msg);
    ipcRenderer.on('job:event', listener);
    return () => ipcRenderer.removeListener('job:event', listener);
  },

  startDrag: (filePath) => ipcRenderer.send('drag:start', filePath),
  getPathForFile: (file) => webUtils.getPathForFile(file),
});
