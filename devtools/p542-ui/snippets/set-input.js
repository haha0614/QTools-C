function (v) {
  const el = document.querySelector('.pl-head .pl-input')
  el.value = v
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return el.value
}