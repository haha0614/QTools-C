function () {
  const b = Array.from(document.querySelectorAll('.pl-head .pl-btn')).find((x) => x.textContent.trim() === '新建')
  if (!b) return 'no-btn'
  b.click()
  return 'clicked'
}