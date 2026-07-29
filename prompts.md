
实现一个Electron APP，用来对接后端各种神经网络算法
神经网络算法以C库的形式提供，用Rust实现，然后通过CFFI暴露出。
Electron APP的左栏是Application Type，目前提供两个：
- 伴奏分离
- YingMusic SVC

在应用包体里面来存放所有的内容：
Models/
    yingmusic/
    separation/
每个子目录里面存储对应的网络权重。程序直接从预期的目录里面读权重，不需要配置，因为反正我们每次加一个新模型，也都需要开发一次这个软件。
用户存放的，需要复用的音频，比如说YingMusic-SVC里面的参考timbre音频，放在Application Support目录下的合理位置；~/Library/Application Support/AudioKit/audio/
用户输入和生成的音频放在Caches目录下的合理位置。

需要支持拖放导入/**导出**音频，尤其是算法输出的音频拖放到logic pro。

UI风格：非卡片，VSCode风格，浅蓝色为主色调。

melband-roformer-mlx: https://github.com/Da1sypetals/melband-roformer-mlx
先把yingmusic-svc-mlx和melband-roformer-mlx加为submodule，然后实现UI，以及C接口接入神经网络推理。
所有推理参数都要以**合适的UI**暴露出来。
另外YingMusic::new不应该指定config启动，而是应该指定各个路径启动;cfg应该在推理时指定，而不是初始化时指定，这部分推理代码要改。

---

输入音频的逻辑应该是拖动到左边的侧栏，拖动进去之后，就自动选中，而不是每个APP都拖到自己的那个框里面。
音高允许-24~24个半音。步长为一个半音，并且两侧提供 +12和-12的按钮。点击 +12按钮跳转到 +12，而不是基于当前的按钮加12，-12也是相同的道理。
另外这些UI十分的丑陋，尤其是右上角那些按钮，你应该使用vscode的设计，而不是自创。

---

1. 双击应该可以编辑参数（注意吸附到参数的允许的定义域之内）；
2. bug: 比如yingmusic-svc，填充所有参数之后“开始转换”还是gray out的状态。

---

提供YingMusic音色库的改名功能，注意处理重名。选中后enter改名
如何编译、构建、安装。对release文档进行trim，只保留人要做什么的流程。
yingmusic-svc默认的音高应该是+12而不是0
输出音频播放需要有一个进度条。旁边的按钮是播放和暂停，播放到结束之后，进度条自动归零，然后变成暂停状态
