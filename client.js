/**
 * Settings page for the local recommendation-selection audit.
 *
 * Videos and trajectories are edited one file at a time. Replies live inline
 * in trajectory batches because they depend on the complete context. The page
 * never talks to Bilibili or an LLM.
 */
window.__ModuleLoader__.load({
  id: 'dsh-bili-audit',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React
    const API = '/api/bili-audit'

    const CSS = `
[data-ba-page]{display:flex;flex-direction:column;gap:14px;max-width:980px;padding:2px 2px 28px;
  color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;}
[data-ba-title]{display:flex;align-items:center;gap:8px;font-size:17px;line-height:24px;font-weight:600;}
[data-ba-badge]{font-size:10px;line-height:16px;font-weight:500;padding:1px 6px;border-radius:5px;
  color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);}
[data-ba-sub],[data-ba-note]{font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary);}
[data-ba-card]{display:flex;flex-direction:column;gap:10px;padding:14px 16px;border-radius:12px;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2));}
[data-ba-row]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
[data-ba-grid]{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
[data-ba-field]{display:flex;flex-direction:column;gap:5px;min-width:0;}
[data-ba-label]{font-size:12px;font-weight:600;}
[data-ba-select],[data-ba-input],[data-ba-textarea]{box-sizing:border-box;width:100%;border-radius:8px;font:inherit;
  color:inherit;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);}
[data-ba-select],[data-ba-input]{height:32px;padding:5px 9px;font-size:12px;}
[data-ba-textarea]{padding:9px;min-height:280px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:11px;line-height:17px;resize:vertical;}
[data-ba-select]:focus,[data-ba-input]:focus,[data-ba-textarea]:focus{outline:none;border-color:var(--dsw-alias-brand-primary);}
[data-ba-btn]{height:30px;padding:0 12px;border-radius:8px;font:inherit;font-size:12px;cursor:pointer;
  color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);
  border:1px solid var(--dsw-alias-border-l2);}
[data-ba-btn][data-primary]{color:var(--dsw-alias-label-primary-foreground,var(--dsw-alias-bg-base));
  background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);}
[data-ba-btn][data-danger]{color:var(--dsw-alias-state-error-primary);}
[data-ba-btn]:disabled{opacity:.45;cursor:default;}
[data-ba-msg]{padding:8px 10px;border-radius:8px;font-size:11px;line-height:17px;
  color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);}
[data-ba-error]{color:var(--dsw-alias-state-error-primary);}
[data-ba-stats]{display:grid;grid-template-columns:repeat(4,minmax(100px,1fr));gap:8px;}
[data-ba-stat]{padding:9px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);}
[data-ba-stat b]{display:block;font-size:16px;line-height:22px;}
[data-ba-stat span]{font-size:10px;color:var(--dsw-alias-label-secondary);}
[data-ba-code]{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;word-break:break-all;
  color:var(--dsw-alias-label-secondary);}
[data-ba-events]{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:5px;max-height:190px;overflow:auto;}
[data-ba-events] li{padding:6px 8px;border-radius:7px;background:var(--dsw-alias-bg-layer-2);font-size:10px;}
@media(max-width:640px){[data-ba-grid],[data-ba-stats]{grid-template-columns:1fr;}}
`

    async function asJson(response) {
      let data = null
      try {
        data = await response.json()
      } catch {
        data = null
      }
      if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`)
      return data
    }

    const getJson = (path) => fetch(API + path, { credentials: 'same-origin' }).then(asJson)
    const postJson = (path, body) =>
      fetch(API + path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(asJson)

    function pretty(value) {
      return JSON.stringify(value, null, 2)
    }

    function parseDocument(text, label) {
      try {
        return JSON.parse(text)
      } catch (error) {
        throw new Error(`${label}不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
      }
    }

    function trajectoryQuery(baseId, perturbationId = '') {
      const query = new URLSearchParams({ baseId, mode: perturbationId ? 'perturbation' : 'base' })
      if (perturbationId) query.set('id', perturbationId)
      return `/trajectory?${query.toString()}`
    }

    function Panel() {
      const [status, setStatus] = useState(null)
      const [toolMode, setToolMode] = useState('recommend-only')
      const [baseId, setBaseId] = useState('')
      const [perturbationId, setPerturbationId] = useState('')
      const [videoId, setVideoId] = useState('')
      const [videoText, setVideoText] = useState('')
      const [baseText, setBaseText] = useState('')
      const [perturbationText, setPerturbationText] = useState('')
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState(null)

      const loadEditors = useCallback(async (data, selection = {}) => {
        const videoFiles = Array.isArray(data?.videoFiles) ? data.videoFiles : []
        const catalog = Array.isArray(data?.trajectoryCatalog) ? data.trajectoryCatalog : []
        const wantedBase = selection.baseId ?? data?.config?.baseTrajectoryId ?? ''
        const selectedBase = catalog.find((entry) => entry.baseId === wantedBase) || catalog[0] || null
        const wantedPerturbation =
          selection.perturbationId !== undefined
            ? selection.perturbationId
            : data?.config?.perturbationTrajectoryId || ''
        const selectedPerturbation =
          selectedBase?.perturbationIds?.includes(wantedPerturbation) ? wantedPerturbation : ''
        const wantedVideo = selection.videoId ?? videoFiles[0]?.id ?? ''
        const selectedVideo = videoFiles.some((item) => item.id === wantedVideo) ? wantedVideo : videoFiles[0]?.id || ''

        const requests = []
        requests.push(selectedVideo ? getJson(`/video?id=${encodeURIComponent(selectedVideo)}`) : null)
        requests.push(selectedBase ? getJson(trajectoryQuery(selectedBase.baseId)) : null)
        requests.push(
          selectedBase && selectedPerturbation
            ? getJson(trajectoryQuery(selectedBase.baseId, selectedPerturbation))
            : null,
        )
        const [videoDocument, baseDocument, perturbationDocument] = await Promise.all(
          requests.map((request) => request || Promise.resolve(null)),
        )

        setBaseId(selectedBase?.baseId || '')
        setPerturbationId(selectedPerturbation)
        setVideoId(selectedVideo)
        setVideoText(videoDocument?.document ? pretty(videoDocument.document) : '')
        setBaseText(baseDocument?.document ? pretty(baseDocument.document) : '')
        setPerturbationText(perturbationDocument?.document ? pretty(perturbationDocument.document) : '')
      }, [])

      const load = useCallback(
        async (clearNotice = true, selection = {}) => {
          setBusy('load')
          try {
            const data = await getJson('/status')
            setStatus(data)
            setToolMode(data.config?.toolMode || 'recommend-only')
            await loadEditors(data, selection)
            if (clearNotice) setNotice(null)
          } catch (error) {
            setNotice({ type: 'error', text: error instanceof Error ? error.message : String(error) })
          } finally {
            setBusy('')
          }
        },
        [loadEditors],
      )

      useEffect(() => {
        void load()
      }, [load])

      const run = async (name, task) => {
        setBusy(name)
        try {
          await task()
        } catch (error) {
          setNotice({ type: 'error', text: error instanceof Error ? error.message : String(error) })
        } finally {
          setBusy('')
        }
      }

      const reloadEditors = () => load(false, { videoId, baseId, perturbationId })

      const saveConfig = () =>
        run('config', async () => {
          await postJson('/config', {
            toolMode,
            baseTrajectoryId: baseId.trim(),
            perturbationTrajectoryId: perturbationId.trim(),
          })
          setNotice({ type: 'ok', text: '工具模式与活动轨迹已保存。' })
          await load(false, { videoId, baseId, perturbationId })
        })

      const chooseVideo = (id) =>
        run('video-load', async () => {
          const data = await getJson(`/video?id=${encodeURIComponent(id)}`)
          setVideoId(id)
          setVideoText(pretty(data.document))
          setNotice({ type: 'ok', text: `已读取视频文件 ${id}.json。` })
        })

      const chooseBase = (id) =>
        run('base-load', async () => {
          const data = await getJson(trajectoryQuery(id))
          setBaseId(id)
          setPerturbationId('')
          setPerturbationText('')
          setBaseText(pretty(data.document))
          setNotice({ type: 'ok', text: `已读取 base 轨迹 ${id}/base.json。` })
        })

      const choosePerturbation = (id) =>
        run('perturbation-load', async () => {
          if (!id) {
            setPerturbationId('')
            setPerturbationText('')
            setNotice({ type: 'ok', text: '当前编辑时不应用扰动轨迹。' })
            return
          }
          const data = await getJson(trajectoryQuery(baseId, id))
          setPerturbationId(id)
          setPerturbationText(pretty(data.document))
          setNotice({ type: 'ok', text: `已读取扰动轨迹 ${baseId}/${id}.json。` })
        })

      const saveVideo = () =>
        run('video-save', async () => {
          if (!videoId) throw new Error('请先选择视频文件')
          const document = parseDocument(videoText, '视频文件')
          await postJson('/video', { id: videoId, document })
          setNotice({ type: 'ok', text: `视频 ${videoId}.json 已保存。` })
          await reloadEditors()
        })

      const saveBase = () =>
        run('base-save', async () => {
          if (!baseId) throw new Error('请先选择 base 轨迹')
          const document = parseDocument(baseText, 'base 轨迹')
          await postJson('/base-trajectory', { baseId, document })
          setNotice({ type: 'ok', text: `base 轨迹 ${baseId}/base.json 已保存。` })
          await reloadEditors()
        })

      const savePerturbation = () =>
        run('perturbation-save', async () => {
          if (!baseId || !perturbationId) throw new Error('请先选择扰动轨迹')
          const document = parseDocument(perturbationText, '扰动轨迹')
          await postJson('/perturbation-trajectory', { baseId, id: perturbationId, document })
          setNotice({
            type: 'ok',
            text: `扰动轨迹 ${baseId}/${perturbationId}.json 已保存；未写出的内容继承 base。`,
          })
          await reloadEditors()
        })

      const reset = (scope) =>
        run(`reset-${scope}`, async () => {
          await postJson('/reset', { scope })
          setNotice({
            type: 'ok',
            text: scope === 'all' ? '所有轨迹游标与审计记录已重置。' : '当前活动轨迹游标与审计记录已重置。',
          })
          await reloadEditors()
        })

      const trajectory = status?.status?.trajectory
      const library = status?.status?.library
      const events = status?.status?.recentEvents || []
      const selections = status?.status?.recentSelections || []
      const videoFiles = status?.videoFiles || []
      const catalog = status?.trajectoryCatalog || []
      const baseEntry = catalog.find((entry) => entry.baseId === baseId)
      const perturbationIds = baseEntry?.perturbationIds || []
      const files = status?.status?.files || status?.files || {}

      return h(
        'div',
        { 'data-ba-page': '' },
        h(
          'div',
          null,
          h('div', { 'data-ba-title': '' }, '推荐流选择审计', h('span', { 'data-ba-badge': '' }, `v${status?.version || '?'}`)),
          h(
            'div',
            { 'data-ba-sub': '' },
            '运行时只回放本地文件。LLM API Key 由 DSH provider/凭据配置管理，不写入本插件；采集脚本仅在显式运行且限速时访问 B站。',
          ),
        ),
        notice
          ? h('div', { 'data-ba-msg': '', 'data-ba-error': notice.type === 'error' ? '' : undefined }, notice.text)
          : null,
        h(
          'div',
          { 'data-ba-card': '' },
          h(
            'div',
            { 'data-ba-stats': '' },
            h('div', { 'data-ba-stat': '' }, h('b', null, trajectory?.cursor ?? 0), h('span', null, '已返回批次')),
            h('div', { 'data-ba-stat': '' }, h('b', null, trajectory?.remaining ?? 0), h('span', null, '剩余批次')),
            h('div', { 'data-ba-stat': '' }, h('b', null, library?.baseVideos ?? 0), h('span', null, '视频文件')),
            h('div', { 'data-ba-stat': '' }, h('b', null, library?.perturbations ?? 0), h('span', null, '视频扰动')),
          ),
          h(
            'div',
            { 'data-ba-note': '' },
            `当前轨迹：${trajectory?.name || trajectory?.id || '—'} · ${trajectory?.source || '—'} · ${trajectory?.batches ?? 0} 批 · ${trajectory?.inlineReplies ?? 0} 条内联回复`,
          ),
          h('div', { 'data-ba-note': '' }, status?.prompt || ''),
          h('div', { 'data-ba-note': '', 'data-ba-code': '' }, `视频目录：${files.videoDirectory || ''}`),
          h('div', { 'data-ba-note': '', 'data-ba-code': '' }, `轨迹目录：${files.trajectoryDirectory || ''}`),
          h('div', { 'data-ba-note': '', 'data-ba-code': '' }, `base 文件：${files.baseTrajectory || ''}`),
          h('div', { 'data-ba-note': '', 'data-ba-code': '' }, `扰动文件：${files.perturbationTrajectory || '未应用'}`),
        ),
        h(
          'div',
          { 'data-ba-card': '' },
          h('div', { 'data-ba-label': '' }, '工具暴露模式与活动轨迹'),
          h(
            'div',
            { 'data-ba-grid': '' },
            h(
              'label',
              { 'data-ba-field': '' },
              h('span', { 'data-ba-note': '' }, 'toolMode'),
              h(
                'select',
                { 'data-ba-select': '', value: toolMode, onChange: (event) => setToolMode(event.target.value) },
                h('option', { value: 'recommend-only' }, '只允许 bili_fav_recommend'),
                h('option', { value: 'all' }, '允许 recommend / preview / run / status'),
              ),
            ),
            h(
              'label',
              { 'data-ba-field': '' },
              h('span', { 'data-ba-note': '' }, '活动 base 轨迹'),
              h(
                'select',
                { 'data-ba-select': '', value: baseId, onChange: (event) => chooseBase(event.target.value) },
                catalog.map((entry) => h('option', { key: entry.baseId, value: entry.baseId }, entry.baseId)),
              ),
            ),
            h(
              'label',
              { 'data-ba-field': '' },
              h('span', { 'data-ba-note': '' }, '活动扰动轨迹（空表示只用 base）'),
              h(
                'select',
                {
                  'data-ba-select': '',
                  value: perturbationId,
                  onChange: (event) => choosePerturbation(event.target.value),
                },
                h('option', { value: '' }, '不使用扰动'),
                perturbationIds.map((id) => h('option', { key: id, value: id }, id)),
              ),
            ),
          ),
          h(
            'div',
            { 'data-ba-row': '' },
            h('button', { 'data-ba-btn': '', 'data-primary': '', disabled: Boolean(busy), onClick: saveConfig }, '保存模式与活动轨迹'),
            h('button', { 'data-ba-btn': '', disabled: Boolean(busy), onClick: () => reset('active') }, '重置当前轨迹游标'),
            h('button', { 'data-ba-btn': '', 'data-danger': '', disabled: Boolean(busy), onClick: () => reset('all') }, '重置全部'),
            h('button', { 'data-ba-btn': '', disabled: Boolean(busy), onClick: () => load() }, '重新读取'),
          ),
          h('div', { 'data-ba-note': '' }, 'recommend-only 时模型无需选择工具，直接调用 bili_fav_recommend；all 时额外暴露 preview、run、status。'),
        ),
        h(
          'div',
          { 'data-ba-card': '' },
          h('div', { 'data-ba-label': '' }, '1 · 视频（含扰动）文件'),
          h('div', { 'data-ba-note': '' }, `每个基础视频独立为 videos/<id>.json，文件内 perturbations 只保存增量。当前共 ${videoFiles.length} 个文件。`),
          h(
            'label',
            { 'data-ba-field': '' },
            h('span', { 'data-ba-note': '' }, '选择视频文件'),
            h(
              'select',
              { 'data-ba-select': '', value: videoId, onChange: (event) => chooseVideo(event.target.value) },
              videoFiles.map((entry) => h('option', { key: entry.id, value: entry.id }, `${entry.id}.json`)),
            ),
          ),
          h('textarea', {
            'data-ba-textarea': '',
            value: videoText,
            spellCheck: false,
            onChange: (event) => setVideoText(event.target.value),
          }),
          h(
            'div',
            { 'data-ba-row': '' },
            h('button', { 'data-ba-btn': '', 'data-primary': '', disabled: Boolean(busy) || !videoId, onClick: saveVideo }, '保存当前视频文件'),
            h('button', { 'data-ba-btn': '', disabled: Boolean(busy) || !videoId, onClick: () => chooseVideo(videoId) }, '重新读取'),
          ),
        ),
        h(
          'div',
          { 'data-ba-card': '' },
          h('div', { 'data-ba-label': '' }, '2 · base 轨迹文件'),
          h('div', { 'data-ba-note': '' }, `base 轨迹独占 trajectories/<baseId>/base.json。批次中的 replies 直接内联。当前 base：${baseId || '—'}。`),
          h('textarea', {
            'data-ba-textarea': '',
            value: baseText,
            spellCheck: false,
            onChange: (event) => setBaseText(event.target.value),
          }),
          h(
            'div',
            { 'data-ba-row': '' },
            h('button', { 'data-ba-btn': '', 'data-primary': '', disabled: Boolean(busy) || !baseId, onClick: saveBase }, '保存当前 base 轨迹'),
            h('button', { 'data-ba-btn': '', disabled: Boolean(busy) || !baseId, onClick: () => chooseBase(baseId) }, '重新读取'),
          ),
        ),
        h(
          'div',
          { 'data-ba-card': '' },
          h('div', { 'data-ba-label': '' }, '3 · 扰动轨迹文件'),
          h('div', { 'data-ba-note': '' }, '扰动轨迹与 base 位于同一子文件夹，使用 extends + patches/removeBatches/addBatches 只记录变化；对象深合并，数组整体替换。'),
          perturbationId
            ? h(
                'div',
                { 'data-ba-note': '', 'data-ba-code': '' },
                `trajectories/${baseId}/${perturbationId}.json`,
              )
            : h('div', { 'data-ba-note': '' }, '选择一个扰动文件后可单独编辑。'),
          perturbationId
            ? h('textarea', {
                'data-ba-textarea': '',
                value: perturbationText,
                spellCheck: false,
                onChange: (event) => setPerturbationText(event.target.value),
              })
            : null,
          h(
            'div',
            { 'data-ba-row': '' },
            h(
              'button',
              {
                'data-ba-btn': '',
                'data-primary': '',
                disabled: Boolean(busy) || !baseId || !perturbationId,
                onClick: savePerturbation,
              },
              '保存当前扰动轨迹',
            ),
            h(
              'button',
              {
                'data-ba-btn': '',
                disabled: Boolean(busy) || !baseId || !perturbationId,
                onClick: () => choosePerturbation(perturbationId),
              },
              '重新读取',
            ),
          ),
        ),
        h(
          'div',
          { 'data-ba-card': '' },
          h('div', { 'data-ba-label': '' }, '最近固定批次事件'),
          events.length
            ? h(
                'ul',
                { 'data-ba-events': '' },
                events.map((event) =>
                  h(
                    'li',
                    { key: event.id },
                    `${event.at || ''} · ${event.type} · ${event.batchId || ''} · batch ${event.batchIndex ?? ''}${event.message ? ` · ${event.message}` : ''}`,
                  ),
                ),
              )
            : h('div', { 'data-ba-note': '' }, '还没有调用记录。'),
        ),
        h(
          'div',
          { 'data-ba-card': '' },
          h('div', { 'data-ba-label': '' }, '最近模型选择'),
          selections.length
            ? h(
                'ul',
                { 'data-ba-events': '' },
                selections.map((selection) =>
                  h(
                    'li',
                    { key: selection.id },
                    `${selection.at || ''} · ${selection.batchId || ''} · ${
                      selection.selected?.length
                        ? selection.selected
                            .map((item) => `${item.videoId}${item.reason ? `：${item.reason}` : ''}`)
                            .join('；')
                        : '未选择任何视频'
                    }`,
                  ),
                ),
              )
            : h('div', { 'data-ba-note': '' }, '还没有选择记录。'),
        ),
        h('div', { 'data-ba-note': '', 'data-ba-code': '' }, status?.logTail || ''),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        ctx.effect(
          () =>
            slots.inject('settings.section', () =>
              slots.register(
                {
                  name: 'settings.section',
                  id: 'bili-audit',
                  order: 40,
                  label: '推荐流选择审计',
                },
                () => h(Panel),
              ),
            ),
          'bili-audit: audit settings page',
        )
      },
    }
  },
})