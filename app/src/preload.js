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
  setInputCategory: (name, category) => ipcRenderer.invoke('input:set-category', name, category),

  listOutputs: () => ipcRenderer.invoke('outputs:list'),
  deleteOutput: (dirName) => ipcRenderer.invoke('outputs:delete', dirName),
  writeVideo: (filePath, bytes) => ipcRenderer.invoke('video:write', filePath, bytes),
  reveal: (filePath) => ipcRenderer.invoke('file:reveal', filePath),

  runSep: (options) => ipcRenderer.invoke('job:sep', options),
  runSvc: (options) => ipcRenderer.invoke('job:svc', options),

  fetchLrc: (input) => ipcRenderer.invoke('lrc:fetch', input),
  pickImage: () => ipcRenderer.invoke('lrcvideo:pick-image'),
  readImage: (filePath) => ipcRenderer.invoke('lrcvideo:read-image', filePath),
  listFonts: () => ipcRenderer.invoke('lrcvideo:list-fonts'),
  saveLrcVideo: (options) => ipcRenderer.invoke('lrcvideo:save', options),
  saveLrcCover: (options) => ipcRenderer.invoke('lrccover:save', options),

  onJobEvent: (callback) => {
    const listener = (_event, msg) => callback(msg);
    ipcRenderer.on('job:event', listener);
    return () => ipcRenderer.removeListener('job:event', listener);
  },

  onFilesChanged: (callback) => {
    const listener = (_event, msg) => callback(msg);
    ipcRenderer.on('files:changed', listener);
    return () => ipcRenderer.removeListener('files:changed', listener);
  },

  startDrag: (filePath) => ipcRenderer.send('drag:start', filePath),
  getPathForFile: (file) => webUtils.getPathForFile(file),
});
