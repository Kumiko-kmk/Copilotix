import React from 'react'
import { Alert, Button, Checkbox, Empty, Input, Modal, Spin, message } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import type { AppSettings } from '@shared/types'
import { ZOTERO_IMPORT_MAX, type ZoteroCatalog, type ZoteroCollection, type ZoteroItem } from '../contract/zotero'
import './zoteroImport.css'

type Scope = string | null

/**
 * Browse the local Zotero library (read-only) and import the PDFs of the checked items.
 * Duplicates are decided by PDF hash in Main; already linked items show as imported.
 */
export default function ZoteroImportDialog(props: {
  open: boolean
  settings: AppSettings
  onClose(): void
  onImported(): void
  onOpenSettings(): void
}): React.JSX.Element {
  const [catalog, setCatalog] = React.useState<ZoteroCatalog | null>(null)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [scope, setScope] = React.useState<Scope>(null)
  const [query, setQuery] = React.useState('')
  const [items, setItems] = React.useState<ZoteroItem[]>([])
  const [next, setNext] = React.useState<number | null>(null)
  const [total, setTotal] = React.useState(0)
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set())
  const [importing, setImporting] = React.useState(false)
  const [messageApi, contextHolder] = message.useMessage()
  const pageRequest = React.useRef(0)

  const loadCatalog = React.useCallback(async (refresh: boolean) => {
    setLoading(true)
    setLoadError(null)
    try {
      setCatalog(await window.copilotix.zotero.catalog({ refresh }))
      setSelected(new Set())
    } catch (error) {
      setCatalog(null)
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    if (props.open) void loadCatalog(true)
  }, [loadCatalog, props.open])

  const loadPage = React.useCallback(async (after: number | undefined) => {
    if (!catalog) return
    const request = ++pageRequest.current
    try {
      const page = await window.copilotix.zotero.items({ snapshotId: catalog.snapshotId, collectionKey: scope, query: query.trim() || undefined, after })
      if (request !== pageRequest.current) return
      setItems((current) => after ? [...current, ...page.items] : page.items)
      setNext(page.next)
      setTotal(page.total)
    } catch (error) {
      if (request === pageRequest.current) setLoadError(error instanceof Error ? error.message : String(error))
    }
  }, [catalog, query, scope])

  React.useEffect(() => {
    const timer = window.setTimeout(() => void loadPage(undefined), query ? 180 : 0)
    return () => window.clearTimeout(timer)
  }, [loadPage, query])

  const selectable = items.filter((item) => !item.importedDocumentId)
  const allVisibleSelected = selectable.length > 0 && selectable.every((item) => selected.has(item.itemKey))
  const toggle = (itemKey: string, checked: boolean): void => {
    setSelected((current) => {
      const nextSet = new Set(current)
      if (checked) nextSet.add(itemKey)
      else nextSet.delete(itemKey)
      return nextSet
    })
  }
  const toggleVisible = (checked: boolean): void => {
    setSelected((current) => {
      const nextSet = new Set(current)
      for (const item of selectable) {
        if (checked) nextSet.add(item.itemKey)
        else nextSet.delete(item.itemKey)
      }
      return nextSet
    })
  }

  const parserState = props.settings.credentials.parser.state
  const parserBlocked = parserState === 'missing' || parserState === 'invalid'
  const tooMany = selected.size > ZOTERO_IMPORT_MAX

  const runImport = async (): Promise<void> => {
    if (!catalog || selected.size === 0) return
    setImporting(true)
    try {
      const result = await window.copilotix.zotero.importItems({ snapshotId: catalog.snapshotId, itemKeys: [...selected] })
      const parts = [
        result.created > 0 ? `新建 ${result.created} 篇` : null,
        result.linked > 0 ? `${result.linked} 篇已在文库中，已关联 Zotero 条目` : null
      ].filter(Boolean)
      if (result.failed.length > 0) {
        const examples = result.failed.slice(0, 3).map((item) => `${item.name}（${item.message}）`).join('；')
        messageApi.warning(`${result.failed.length} 篇未导入：${examples}${result.failed.length > 3 ? ' 等' : ''}`)
      }
      if (parts.length > 0) messageApi.success(parts.join('，'))
      if (result.created > 0) props.onImported()
      setSelected(new Set())
      await loadPage(undefined)
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : String(error))
    } finally {
      setImporting(false)
    }
  }

  return (
    <Modal
      className="zotero-import-dialog"
      title="从 Zotero 导入"
      open={props.open}
      width={920}
      onCancel={() => { if (!importing) props.onClose() }}
      maskClosable={!importing}
      footer={(
        <div className="zotero-import-footer">
          <span>{tooMany ? `一次最多导入 ${ZOTERO_IMPORT_MAX} 篇` : `已选 ${selected.size} 篇`}</span>
          <Button onClick={props.onClose} disabled={importing}>取消</Button>
          <Button type="primary" loading={importing} disabled={!catalog || selected.size === 0 || tooMany || parserBlocked} onClick={() => void runImport()}>
            导入所选
          </Button>
        </div>
      )}
    >
      {contextHolder}
      {parserBlocked ? (
        <Alert className="zotero-import-alert" type="warning" showIcon message={parserState === 'missing' ? '需要先配置解析 API Token' : 'Parser API Token 验证失败'}
          description={<Button type="link" onClick={props.onOpenSettings}>前往系统设置</Button>} />
      ) : null}
      {loadError ? (
        <Alert className="zotero-import-alert" type="error" showIcon message="无法读取 Zotero 文库" description={loadError}
          action={<Button size="small" onClick={() => void loadCatalog(true)}>重试</Button>} />
      ) : null}
      {catalog ? (
        <div className="zotero-import-source" role="status">
          <span>
            {catalog.source === 'local-api'
              ? '已连接正在运行的 Zotero（只读）'
              : `${catalog.fallbackReason ?? 'Zotero 本机接口不可用'}，改为读取 zotero.sqlite 的只读副本`}
          </span>
          <Button type="text" size="small" icon={<ReloadOutlined />} aria-label="重新读取 Zotero 文库" loading={loading} onClick={() => void loadCatalog(true)} />
        </div>
      ) : null}
      {loading && !catalog ? <div className="zotero-import-loading"><Spin /></div> : null}
      {catalog ? (
        <div className="zotero-import-body">
          <nav className="zotero-import-collections" aria-label="Zotero 分类">
            <ScopeButton active={scope === null} label="全部条目" count={catalog.totalItems} depth={0} onClick={() => setScope(null)} />
            <CollectionTree collections={catalog.collections} scope={scope} onSelect={setScope} />
            <ScopeButton active={scope === 'unfiled'} label="未分类条目" count={catalog.unfiledItems} depth={0} onClick={() => setScope('unfiled')} />
          </nav>
          <section className="zotero-import-items" aria-label="含 PDF 的 Zotero 条目">
            <div className="zotero-import-toolbar">
              <Checkbox checked={allVisibleSelected} indeterminate={!allVisibleSelected && selectable.some((item) => selected.has(item.itemKey))}
                disabled={selectable.length === 0} onChange={(event) => toggleVisible(event.target.checked)}>全选已列出</Checkbox>
              <Input.Search allowClear placeholder="按标题、作者或年份筛选" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="筛选 Zotero 条目" />
              <small>{total} 条含 PDF</small>
            </div>
            <div className="zotero-import-list">
              {items.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有含 PDF 附件的条目" /> : null}
              {items.map((item) => (
                <label className={item.importedDocumentId ? 'zotero-import-item imported' : 'zotero-import-item'} key={item.itemKey}>
                  <Checkbox checked={Boolean(item.importedDocumentId) || selected.has(item.itemKey)} disabled={Boolean(item.importedDocumentId)}
                    onChange={(event) => toggle(item.itemKey, event.target.checked)} />
                  <span className="zotero-import-item-text">
                    <strong>{item.title}</strong>
                    <small>{[item.creators, item.year].filter(Boolean).join(' · ') || '未知作者'}{item.pdfCount > 1 ? ` · ${item.pdfCount} 个 PDF，导入第一个` : ''}</small>
                  </span>
                  {item.importedDocumentId ? <span className="zotero-import-badge">已导入</span> : null}
                </label>
              ))}
              {next !== null ? <Button type="link" onClick={() => void loadPage(next)}>加载更多</Button> : null}
            </div>
          </section>
        </div>
      ) : null}
    </Modal>
  )
}

function CollectionTree(props: { collections: ZoteroCollection[]; scope: Scope; onSelect(scope: Scope): void }): React.JSX.Element {
  const children = React.useMemo(() => {
    const map = new Map<string | null, ZoteroCollection[]>()
    for (const collection of props.collections) map.set(collection.parentKey, [...map.get(collection.parentKey) ?? [], collection])
    for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    return map
  }, [props.collections])
  const render = (parent: string | null, depth: number): React.ReactNode => (children.get(parent) ?? []).map((collection) => (
    <React.Fragment key={collection.key}>
      <ScopeButton active={props.scope === collection.key} label={collection.name} count={collection.itemCount} depth={depth} onClick={() => props.onSelect(collection.key)} />
      {render(collection.key, depth + 1)}
    </React.Fragment>
  ))
  return <>{render(null, 1)}</>
}

function ScopeButton(props: { active: boolean; label: string; count: number; depth: number; onClick(): void }): React.JSX.Element {
  return (
    <button type="button" className={props.active ? 'zotero-scope active' : 'zotero-scope'} aria-current={props.active ? 'true' : undefined}
      style={{ paddingLeft: 10 + Math.max(0, props.depth - 1) * 14 }} onClick={props.onClick}>
      <span>{props.label}</span>
      <small>{props.count}</small>
    </button>
  )
}
