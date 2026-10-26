(async () => {
  const owner = localStorage.getItem('ms.owner') || ''
  const h = owner ? { 'X-Ms-Owner': owner } : {}
  const res = await fetch('/api/media/playlists', { headers: h })
  const list = await res.json()
  const arr = Array.isArray(list) ? list : ((list && list.data) || [])
  const ids = arr.filter((p) => String(p.name || '').indexOf('P542 ') === 0).map((p) => p.id)
  const out = []
  for (const id of ids) {
    const r = await fetch('/api/media/playlist/' + id, { method: 'DELETE', headers: h })
    out.push({ id: id, status: r.status })
  }
  return { ownerPrefix: owner.slice(0, 8), before: arr.length, deleted: out }
})()