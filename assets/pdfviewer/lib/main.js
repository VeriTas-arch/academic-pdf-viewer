"use strict";

(function () {
  function loadConfig() {
    const elem = document.getElementById('pdf-preview-config')
    if (elem) {
      return JSON.parse(elem.getAttribute('data-config'))
    }
    throw new Error('Could not load configuration.')
  }
  function cursorTools(name) {
    if (name === 'hand') {
      return 1
    }
    return 0
  }
  function scrollMode(name) {
    switch (name) {
      case 'vertical':
        return 0
      case 'horizontal':
        return 1
      case 'wrapped':
        return 2
      default:
        return -1
    }
  }
  function spreadMode(name) {
    switch (name) {
      case 'none':
        return 0
      case 'odd':
        return 1
      case 'even':
        return 2
      default:
        return -1
    }
  }
  function configureViewerOptions(targetWindow, config) {
    const options = targetWindow.PDFViewerApplicationOptions
    if (!options) {
      return false
    }

    options.set('disablePreferences', true)
    options.set('defaultUrl', '')
    options.set('disableHistory', true)
    options.set('enableScripting', false)
    options.set('cMapUrl', config.cMapUrl)
    options.set('iccUrl', config.iccUrl)
    options.set('imageResourcesPath', config.imageResourcesPath)
    options.set('sandboxBundleSrc', config.sandboxBundleSrc)
    options.set('standardFontDataUrl', config.standardFontDataUrl)
    options.set('wasmUrl', config.wasmUrl)
    options.set('workerSrc', config.workerSrc)
    options.set('cursorToolOnLoad', cursorTools(config.defaults.cursor))
    options.set('defaultZoomValue', config.defaults.scale)
    options.set('scrollModeOnLoad', scrollMode(config.defaults.scrollMode))
    options.set('spreadModeOnLoad', spreadMode(config.defaults.spreadMode))
    options.set('sidebarViewOnLoad', config.defaults.sidebar ? 1 : 0)
    return true
  }
  function captureViewerState() {
    const viewer = PDFViewerApplication.pdfViewer
    const container = viewer && viewer.container
    if (!viewer || !container || !PDFViewerApplication.pdfDocument) {
      return null
    }
    return {
      pageNumber: viewer.currentPageNumber,
      scale: viewer.currentScale,
      scrollLeft: container.scrollLeft,
      scrollTop: container.scrollTop
    }
  }
  function restoreViewerState(state) {
    const viewer = PDFViewerApplication.pdfViewer
    const container = viewer && viewer.container
    if (!viewer || !container || !state) {
      return
    }

    if (Number.isFinite(state.scale) && state.scale > 0) {
      viewer.currentScaleValue = String(state.scale)
    }
    if (Number.isInteger(state.pageNumber)) {
      viewer.currentPageNumber = Math.min(state.pageNumber, viewer.pagesCount)
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        container.scrollLeft = state.scrollLeft
        container.scrollTop = state.scrollTop
      })
    })
  }

  const config = loadConfig()
  const reportDebug = (event, fields = {}) => {
    if (!config.debug) {
      return
    }
    window.dispatchEvent(new CustomEvent('academic-pdf-debug', {
      detail: { type: 'pdf.debug', event, ...fields }
    }))
  }
  const elapsedSince = startedAt => Math.round(performance.now() - startedAt)
  const errorMessage = error => error instanceof Error ? error.message : String(error)
  let workerBlobUrl = null
  const prepareWorkerSource = async () => {
    const startedAt = performance.now()
    const localWorkerSrc = config.workerSrc
    try {
      const response = await fetch(localWorkerSrc)
      if (!response.ok) {
        throw new Error(`Could not read the bundled PDF worker (${response.status}).`)
      }

      const source = await response.arrayBuffer()
      workerBlobUrl = URL.createObjectURL(new Blob([source], {
        type: 'text/javascript'
      }))
      config.workerSrc = workerBlobUrl
      reportDebug('workerSourcePrepared', {
        durationMs: elapsedSince(startedAt),
        sizeBytes: source.byteLength
      })
    } catch (error) {
      reportDebug('workerSourceFallback', {
        durationMs: elapsedSince(startedAt),
        error: errorMessage(error)
      })
      await import(localWorkerSrc)
    }
  }
  const workerSourceReady = prepareWorkerSource()
  window.addEventListener('pagehide', () => {
    if (workerBlobUrl) {
      URL.revokeObjectURL(workerBlobUrl)
      workerBlobUrl = null
    }
  }, { once: true })
  const configureOnViewerLoaded = event => {
    configureViewerOptions(event.detail && event.detail.source || window, config)
  }
  document.addEventListener('webviewerloaded', configureOnViewerLoaded, { once: true })
  try {
    if (parent.document !== document) {
      parent.document.addEventListener('webviewerloaded', configureOnViewerLoaded, { once: true })
    }
  } catch {
    // Cross-origin embedding dispatches the event on this document instead.
  }

  window.addEventListener('load', async function () {
    const initializedAt = performance.now()
    await workerSourceReady
    if (!configureViewerOptions(window, config)) {
      throw new Error('PDF.js viewer options are unavailable.')
    }

    const loadOpts = {
      useWorkerFetch: false,
      cMapUrl: config.cMapUrl,
      cMapPacked: true,
      iccUrl: config.iccUrl,
      standardFontDataUrl: config.standardFontDataUrl,
      wasmUrl: config.wasmUrl
    }
    let pendingFirstPageRender = null

    reportDebug('viewerInitializing', {
      workerSource: workerBlobUrl ? 'blob' : 'mainThreadFallback'
    })
    await PDFViewerApplication.initializedPromise
    reportDebug('viewerInitialized', {
      durationMs: elapsedSince(initializedAt),
      workerSource: workerBlobUrl ? 'blob' : 'mainThreadFallback'
    })

    PDFViewerApplication.eventBus.on('pagerendered', event => {
      if (!pendingFirstPageRender || !pendingFirstPageRender.opened) {
        return
      }

      const pending = pendingFirstPageRender
      pendingFirstPageRender = null
      reportDebug('firstPageRendered', {
        fingerprint: pending.fingerprint,
        durationMs: elapsedSince(pending.startedAt),
        pages: PDFViewerApplication.pdfDocument && PDFViewerApplication.pdfDocument.numPages,
        pageNumber: event.pageNumber
      })
    })

    window.addEventListener('message', async function (event) {
      if (!event.data || event.data.type !== 'document.load') {
        return
      }

      const startedAt = performance.now()
      const fingerprint = typeof event.data.fingerprint === 'string' ? event.data.fingerprint : ''
      await PDFViewerApplication.initializedPromise
      if (event.data.isEmptyRevision) {
        pendingFirstPageRender = null
        if (PDFViewerApplication.pdfLoadingTask) {
          await PDFViewerApplication.close()
        }
        showDocumentState('This file does not exist in this revision.')
        reportDebug('emptyRevision', {
          fingerprint,
          durationMs: elapsedSince(startedAt)
        })
        return
      }

      if (!(event.data.data instanceof ArrayBuffer)) {
        const error = 'Invalid binary payload.'
        console.error(`Failed to load PDF document: ${error}`)
        reportDebug('failed', {
          fingerprint,
          durationMs: elapsedSince(startedAt),
          error
        })
        return
      }
      const data = new Uint8Array(event.data.data)

      showDocumentState(null)
      const oldLoad = PDFViewerApplication.load
      PDFViewerApplication.load = function (pdfDocument) {
        if (pdfDocument && pdfDocument._pdfInfo) {
          pdfDocument._pdfInfo.fingerprints = [fingerprint]
        }
        return oldLoad.call(this, pdfDocument)
      }

      const preservedState = event.data.preserveView ? captureViewerState() : null
      let restorePending = false
      const restoreOnDocumentInit = () => {
        PDFViewerApplication.eventBus.off('documentinit', restoreOnDocumentInit)
        restorePending = false
        restoreViewerState(preservedState)
      }
      if (preservedState) {
        restorePending = true
        PDFViewerApplication.eventBus.on('documentinit', restoreOnDocumentInit)
      }

      const pendingRender = { fingerprint, startedAt, opened: false }
      pendingFirstPageRender = pendingRender
      try {
        await PDFViewerApplication.open({ data, ...loadOpts })
        pendingRender.opened = true
        reportDebug('opened', {
          fingerprint,
          durationMs: elapsedSince(startedAt),
          pages: PDFViewerApplication.pdfDocument && PDFViewerApplication.pdfDocument.numPages
        })
      } catch (error) {
        if (restorePending) {
          PDFViewerApplication.eventBus.off('documentinit', restoreOnDocumentInit)
        }
        if (pendingFirstPageRender === pendingRender) {
          pendingFirstPageRender = null
        }
        console.error('Failed to load PDF document.', error)
        reportDebug('failed', {
          fingerprint,
          durationMs: elapsedSince(startedAt),
          error: error instanceof Error ? error.message : String(error)
        })
      } finally {
        PDFViewerApplication.load = oldLoad
      }
    })

    window.dispatchEvent(new CustomEvent('academic-pdf-viewer-ready'))
  }, { once: true })

  function showDocumentState(message) {
    let state = document.getElementById('academicPdfDocumentState')
    if (!state) {
      state = document.createElement('div')
      state.id = 'academicPdfDocumentState'
      state.setAttribute('role', 'status')
      state.hidden = true
      document.body.appendChild(state)
    }

    if (message === null) {
      state.hidden = true
      document.body.classList.remove('academicPdfDocumentUnavailable')
      return
    }

    state.textContent = message
    state.hidden = false
    document.body.classList.add('academicPdfDocumentUnavailable')
  }

  window.addEventListener('unhandledrejection', event => {
    reportDebug('unhandledRejection', {
      error: errorMessage(event.reason)
    })
  })

  window.onerror = function (message, source, line, column, error) {
    reportDebug('windowError', {
      error: error ? errorMessage(error) : String(message),
      source: source || '',
      line: line || 0,
      column: column || 0
    })
    const msg = document.createElement('body')
    msg.innerText = 'An error occurred while loading the file. Please open it again.'
    document.body = msg
  }
}())
