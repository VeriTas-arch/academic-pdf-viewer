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
  window.addEventListener('load', async function () {
    const config = loadConfig()
    PDFViewerApplicationOptions.set('cMapUrl', config.cMapUrl)
    PDFViewerApplicationOptions.set('standardFontDataUrl', config.standardFontDataUrl)
    const loadOpts = {
      useWorkerFetch: false,
      cMapUrl: config.cMapUrl,
      cMapPacked: true,
      standardFontDataUrl: config.standardFontDataUrl
    }
    PDFViewerApplication.initializedPromise.then(() => {
      const defaults = config.defaults
      const optsOnLoad = () => {
        PDFViewerApplication.pdfCursorTools.switchTool(cursorTools(defaults.cursor))
        PDFViewerApplication.pdfViewer.currentScaleValue = defaults.scale
        PDFViewerApplication.pdfViewer.scrollMode = scrollMode(defaults.scrollMode)
        PDFViewerApplication.pdfViewer.spreadMode = spreadMode(defaults.spreadMode)
        if (defaults.sidebar) {
          PDFViewerApplication.pdfSidebar.open()
        } else {
          PDFViewerApplication.pdfSidebar.close()
        }
        PDFViewerApplication.eventBus.off('documentloaded', optsOnLoad)
      }
      PDFViewerApplication.eventBus.on('documentloaded', optsOnLoad)
    })

    window.addEventListener('message', async function (event) {
      if (!event.data || event.data.type !== 'document.load') {
        return
      }

      await PDFViewerApplication.initializedPromise
      if (event.data.isEmptyRevision) {
        if (PDFViewerApplication.pdfLoadingTask) {
          await PDFViewerApplication.close()
        }
        showDocumentState('This file does not exist in this revision.')
        return
      }

      if (!(event.data.data instanceof ArrayBuffer)) {
        console.error('Failed to load PDF document: invalid binary payload.')
        return
      }
      const data = new Uint8Array(event.data.data)

      showDocumentState(null)
      const viewer = PDFViewerApplication.pdfViewer
      const oldResetView = viewer._resetView
      const oldLoad = PDFViewerApplication.load
      PDFViewerApplication.load = function (pdfDocument) {
        if (pdfDocument && pdfDocument._pdfInfo) {
          pdfDocument._pdfInfo.fingerprints = [event.data.fingerprint]
        }
        return oldLoad.call(this, pdfDocument)
      }
      if (event.data.preserveView) {
        // Prevents flickering of the page when the current PDF is reloaded.
        viewer._resetView = function () {
          this._firstPageCapability = (0, pdfjsLib.createPromiseCapability)()
          this._onePageRenderedCapability = (0, pdfjsLib.createPromiseCapability)()
          this._pagesCapability = (0, pdfjsLib.createPromiseCapability)()
          this.viewer.textContent = ""
        }
      }

      try {
        await PDFViewerApplication.open(data, loadOpts)
      } catch (error) {
        console.error('Failed to load PDF document.', error)
      } finally {
        PDFViewerApplication.load = oldLoad
        viewer._resetView = oldResetView
      }
    })

    window.dispatchEvent(new CustomEvent('academic-pdf-viewer-ready'))
  }, { once: true });

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

  window.onerror = function () {
    const msg = document.createElement('body')
    msg.innerText = 'An error occurred while loading the file. Please open it again.'
    document.body = msg
  }
}());
