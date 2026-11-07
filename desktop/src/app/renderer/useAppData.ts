import React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { documentEventDisposition, applyDocumentChange, getDocumentRefreshPlan, patchDocumentDetails, type DocumentListCache } from '@features/library/renderer'
import type { AppSettings } from '@features/settings/contract/settingsTypes'
import type { DocumentChangeEvent, DocumentDetails, DocumentSummary } from '@features/library/contract/documentSchemas'

/** Settings, the live document list and the startup work every edition shares. */
export function useAppData() {
  const queryClient = useQueryClient()
  const settingsQuery = useQuery<AppSettings>({
    queryKey: ['settings'],
    queryFn: () => window.copilotix.getSettings()
  })
  const pendingDocumentEvents = React.useRef<DocumentChangeEvent[]>([])
  const documentsQuery = useQuery<DocumentListCache>({
    queryKey: ['documents'],
    queryFn: async () => {
      let snapshot: DocumentListCache
      for (;;) {
        snapshot = window.copilotix.listDocumentSnapshot ? await window.copilotix.listDocumentSnapshot() : { revision: 0, documents: await window.copilotix.listDocuments() }
        const buffered = pendingDocumentEvents.current.splice(0)
        let gap = false
        for (const change of buffered) {
          const disposition = documentEventDisposition(snapshot, change)
          if (disposition === 'resync') gap = true
          else if (disposition === 'apply') snapshot = applyDocumentChange(snapshot, change)
        }
        if (!gap) break
      }
      const current = queryClient.getQueryData<DocumentListCache>(['documents'])
      return current?.sessionId && current.sessionId === ('sessionId' in snapshot ? snapshot.sessionId : undefined) && current.revision > snapshot.revision ? current : snapshot
    }
  })
  const settings = settingsQuery.data
  const documents = documentsQuery.data?.documents ?? []

  const mergeImported = React.useCallback((created: DocumentSummary[]) => {
    const ids = new Set(created.map((document) => document.id))
    queryClient.setQueryData<DocumentListCache>(['documents'], (current) => ({
      sessionId: current?.sessionId,
      revision: current?.revision ?? 0,
      documents: [...created, ...(current?.documents ?? []).filter((item) => !ids.has(item.id))]
    }))
    // New papers appear wherever papers are listed as soon as they exist.
    void queryClient.invalidateQueries({ queryKey: ['documents'] })
  }, [queryClient])

  const onSettingsSaved = React.useCallback((next: AppSettings) => {
    queryClient.setQueryData(['settings'], next)
  }, [queryClient])

  React.useEffect(() => window.copilotix.onDocumentsChanged((change) => {
    const current = queryClient.getQueryData<DocumentListCache>(['documents'])
    const disposition = documentEventDisposition(current, change)
    if (disposition === 'ignore') return
    if (disposition === 'resync') {
      pendingDocumentEvents.current.push(change)
      if (pendingDocumentEvents.current.length > 1000) pendingDocumentEvents.current.splice(0, 999)
      void queryClient.invalidateQueries({ queryKey: ['documents'] }, { cancelRefetch: false })
      void queryClient.invalidateQueries({ queryKey: ['document'] })
      return
    }
    const previousSummaries = new Map(current?.documents.map((document) => [document.id, document] as const))
    if (!current) {
      void queryClient.invalidateQueries({ queryKey: ['documents'] })
    } else {
      queryClient.setQueryData(['documents'], applyDocumentChange(current, change))
    }

    for (const summary of change.upserted) {
      const refreshPlan = getDocumentRefreshPlan(previousSummaries.get(summary.id), summary, change.changes?.find(item => item.documentId === summary.id)?.kinds)
      queryClient.setQueryData<DocumentDetails>(['document', summary.id], (detail) =>
        patchDocumentDetails(detail, change)
      )
      if (refreshPlan.invalidateDocument) {
        void queryClient.invalidateQueries({ queryKey: ['document', summary.id] })
      }
      for (const view of refreshPlan.annotationViews) {
        void queryClient.invalidateQueries({ queryKey: ['annotations', summary.id, view] })
      }
    }
    for (const documentId of change.removedIds) {
      queryClient.removeQueries({ queryKey: ['document', documentId] })
      queryClient.removeQueries({ queryKey: ['annotations', documentId] })
    }
  }), [queryClient])

  return { settingsQuery, documentsQuery, settings, documents, mergeImported, onSettingsSaved }
}
