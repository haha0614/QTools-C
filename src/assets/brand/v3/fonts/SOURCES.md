# 字体来源与许可证（均为 OFL-1.1）

| 文件 | 字体 | 版本 | 上游 |
|---|---|---|---|
| `smiley-sans.woff2` | 得意黑 Smiley Sans Oblique | v2.0.1 | https://github.com/atelier-anchor/smiley-sans/releases/download/v2.0.1/smiley-sans-v2.0.1.zip（5.78 MB，含现成 woff2/otf/ttf） |
| `noto-sans-sc.woff2` | 思源黑体 Noto Sans SC | 可变字体，已实例化 **wght=500 (Medium)** | https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf（17.77 MB） |
| `lxgw-wenkai.woff2` | 霞鹜文楷 LXGW WenKai Regular | v1.530 | https://github.com/lxgw/LxgwWenKai/releases/download/v1.530/LXGWWenKai-Regular.ttf（25.93 MB） |

## 关于体积

本目录里三个 `.woff2` 都**只含「青兔工具箱」5 个汉字 + 空格**（1.5–2.4 KB），因此可以放心提交。
原始整字库（17–26 MB）**没有提交**。要恢复整字库或扩大字符集：

```bash
# 子集（需要 fonttools + brotli）
python -m pip install fonttools brotli
pyftsubset SmileySans-Oblique.ttf --text="要用的文字" --flavor=woff2 --output-file=out.woff2
# 可变字体取 Medium 实例
fonttools varLib.instancer NotoSansSC[wght].ttf wght=500
```

## 许可证

三种字体均为 **SIL Open Font License 1.1**。OFL 允许用于 logo 与商业产品，但要求：不得单独售卖字体本身；如修改字形并以新名分发需沿用 OFL。字标 SVG 里使用的是**字形轮廓**（非字体软件本身），可自由用于品牌标识。
