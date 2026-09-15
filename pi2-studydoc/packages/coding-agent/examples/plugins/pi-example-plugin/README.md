# `@earendil-works/pi-example-plugin`

此包提供常规的 `session` 与 `tui` Chord facet。Session-worker facet 提供一个远程问候 service。TUI facet 贡献 `/hello` 并调用该 service。

此包无需构建脚本。Pi 要求 Chord 发现 `src/session.ts` 与 `src/tui.ts`，将两个入口构建到其服务器拥有的 plugin 缓存中，并将 TUI 产物发送给客户端。

在仓库根目录下：

```bash
PI_EXPERIMENTAL=1 ./pi-test.sh server \
  -e "$PWD/packages/coding-agent/examples/plugins/pi-example-plugin"
```

或者，客户端可以为其在一个本地服务器上创建或恢复的 Session 选择该 plugin：

```bash
PI_EXPERIMENTAL=1 ./pi-test.sh client \
  -e "$PWD/packages/coding-agent/examples/plugins/pi-example-plugin"
```

重复 `-e` 可选择多个 plugin 包。客户端路径在本地解析，并且仅发送给 Unix 服务器；Radius 客户端无法选择服务器文件系统路径。Session 与匹配的 TUI facet 会随该 Session 一起存储，因此后续的服务器代际与客户端无需 plugin 参数即可恢复它。其他 Session 及其 worker 不受影响。活跃的 Session 会拒绝不同的包选择，而不是被重启。

`server -e` 建立服务器配置文件的默认 Session 与 TUI facet。在没有 `-e` 的情况下启动显式前台服务器会清除该默认值。客户端选择永远不会更改服务器的根 facet 代际。

在 TUI 中运行 `/hello Armin`。编辑 facet 后，运行 `/reload`。服务器会原子地重新构建该包，重新加载已附加的 Session-worker 代际，更新当前 TUI 代际，并将新产物提供给未来的客户端。

包元数据可以覆盖或禁用常规入口：

```json
{
  "chord": {
    "facets": {
      "session": "./src/worker.ts",
      "tui": false
    }
  }
}
```
