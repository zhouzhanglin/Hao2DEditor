import { setLocale } from '@i18n'

/*
 * 测试固定用简中。
 *
 * i18n 的初始语言按 `navigator.language` 猜（见 src/i18n/index.ts）：Node 20+ 暴露了
 * `navigator.language`，在英文系统上跑测试就会拿到英文文案，而断言里写的是中文原文。
 * 这里统一钉死，避免「同样一份代码在不同机器上时好时坏」。
 */
setLocale('zh-CN')
