/**
 * request.js —— axios 实例与统一拦截
 * 用途：全项目唯一的 HTTP 出口；统一 baseURL、超时、响应解包与错误提示。
 * 约定：后端业务响应形如 { code, msg, data }，code === 200 视为成功。
 *      请求配置带 silent: true 时为静默请求，失败不弹任何提示（埋点等场景使用）。
 */
import axios from 'axios'
import { ElMessage } from 'element-plus'

const service = axios.create({
  // 基础路径取自环境变量，缺省回退到 /api
  baseURL: import.meta.env.VITE_API_BASE_URL || '/api',
  timeout: 10000
})

// 响应拦截器
service.interceptors.response.use(
  (res) => {
    const data = res.data
    // 成功分支：从响应配置读取静默标记
    const silent = !!(res.config && res.config.silent === true)

    // 存在业务状态码且非 200 时，非静默请求提示并中断后续流程
    if (data && typeof data === 'object' && data.code !== undefined && data.code !== 200) {
      const msg = data.msg || '请求失败'
      if (!silent) {
        ElMessage.error(msg)
      }
      // 无论是否静默，都保持 reject 行为不变；业务码与原始体挂到 error 上，
      // 调用方据此区分「接口未就绪（401）/ 参数非法 / 无权限」，不必再猜（P5.41）
      const error = new Error(msg)
      error.status = data.code
      error.body = data
      return Promise.reject(error)
    }

    // 直接解包，调用方拿到的就是 data
    return data
  },
  (error) => {
    // 错误分支：axios 会把请求配置挂在 error.config 上
    const silent = !!(error && error.config && error.config.silent === true)

    // 非静默请求的网络类错误（超时、断网、5xx 等）统一给出友好提示
    if (!silent) {
      ElMessage.error('网络异常，请稍后重试')
    }
    return Promise.reject(error)
  }
)

export default service