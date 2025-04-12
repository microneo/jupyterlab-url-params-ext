import { JupyterFrontEnd, JupyterFrontEndPlugin } from '@jupyterlab/application';
import { ISessionContext, ISessionContextDialogs } from '@jupyterlab/apputils';
import { INotebookTracker, Notebook, NotebookActions } from '@jupyterlab/notebook';
import { ITranslator } from '@jupyterlab/translation';

/** A marker that defines the cell where parameters will be inserted. */
const PARAMETERS_MARKER = '# Parameters:';

/** A record type for notebook parameters, where each key is a string and the value is also a string. */
type NotebookParameters = Record<string, string>;

/**
 * A universal function that tries to extract URLSearchParams from the given URL string.
 */
function getSearchParamsFromUrl(urlString: string): URLSearchParams {
  try {
    const url = new URL(urlString);
    return url.searchParams;
  } catch {
    // If the string is invalid as a URL
    return new URLSearchParams();
  }
}

/**
 * Attempts to collect parameters from multiple sources:
 * 1) Current URL (window.location.href)
 * 2) document.referrer
 * 3) sessionStorage
 * 4) Manual parsing (fallback) for any remaining possibilities
 */
function getAllPossibleParams(): URLSearchParams {
  let searchParams = getSearchParamsFromUrl(window.location.href);

  // 1. Attempt referrer, if nothing found in the current URL
  if (searchParams.size === 0 && document.referrer) {
    console.log('notebookparams: trying referrer URL', document.referrer);
    const referrerParams = getSearchParamsFromUrl(document.referrer);

    if (referrerParams.size > 0) {
      searchParams = referrerParams;
    } else {
      // We also try to extract 'next' from the referrer if it has that parameter
      const referrerUrl = new URL(document.referrer);
      const referrerNextParam = referrerUrl.searchParams.get('next');
      if (referrerNextParam && referrerNextParam.includes('%3F')) {
        try {
          const decodedNext = decodeURIComponent(referrerNextParam);
          if (decodedNext.includes('?')) {
            const queryPart = decodedNext.split('?')[1];
            const extractedFromNext = new URLSearchParams(queryPart);
            if (extractedFromNext.size > 0) {
              console.log(
                'notebookparams: extracted params from referrer next parameter',
                extractedFromNext
              );
              searchParams = extractedFromNext;
            }
          }
        } catch (e) {
          console.error('notebookparams: error parsing referrer next parameter', e);
        }
      }
    }
  }

  // 2. If still nothing, check sessionStorage
  if (searchParams.size === 0) {
    try {
      const storedParams = sessionStorage.getItem('jupyterlab_url_params');
      if (storedParams) {
        console.log('notebookparams: found stored parameters', storedParams);
        searchParams = new URLSearchParams(storedParams);
      }
    } catch (e) {
      console.error('notebookparams: error reading sessionStorage', e);
    }
  }

  // 3. If still empty, do a fallback manual parsing on possible URLs
  if (searchParams.size === 0) {
    const fallbackUrls = [window.location.href, document.referrer, window.location.search].filter(
      Boolean
    );

    for (const urlString of fallbackUrls) {
      if (!urlString.includes('?')) {
        continue;
      }
      const queryString = urlString.split('?')[1];
      if (!queryString) {
        continue;
      }
      const extractedParams = new URLSearchParams();
      queryString.split('&').forEach(param => {
        const [key, value] = param.split('=');
        if (key && value) {
          extractedParams.append(key, decodeURIComponent(value));
        }
      });

      if (extractedParams.size > 0) {
        console.log('notebookparams: extracted params manually', extractedParams);
        searchParams = extractedParams;
        // Store for future reloads
        try {
          sessionStorage.setItem('jupyterlab_url_params', searchParams.toString());
        } catch (e) {
          console.error('notebookparams: error storing in sessionStorage', e);
        }
        break;
      }
    }
  }

  return searchParams;
}

/**
 * Parses the 'next' parameter value (e.g. '...next=...') and merges any discovered key-value pairs
 * into the existing params object.
 */
function processNextParameter(params: NotebookParameters, nextValue: string) {
  try {
    const decodedNext = decodeURIComponent(nextValue);
    if (decodedNext.includes('?')) {
      const queryPart = decodedNext.split('?')[1];
      queryPart.split('&').forEach(param => {
        const [key, value] = param.split('=');
        if (key && value) {
          params[key] = decodeURIComponent(value);
        }
      });
    }
  } catch (e) {
    console.error('notebookparams: error parsing next parameter', e);
  }
}

/**
 * Builds a dictionary (object) of all parameters, skipping or merging special cases like 'next'.
 */
function buildParamsFromSearchParams(searchParams: URLSearchParams): NotebookParameters {
  const params: NotebookParameters = {};

  searchParams.forEach((rawValue, rawKey) => {
    const key = rawKey.trim();
    const value = decodeURIComponent(rawValue.trim());

    if (key === 'filepath') {
      // We skip 'filepath' from insertion
      return;
    }
    if (key === 'next' && rawValue.includes('?')) {
      // If it's a 'next' param that itself contains query parameters, parse them
      processNextParameter(params, rawValue);
    } else {
      // Otherwise, just store directly
      params[key] = value;
    }
  });

  return params;
}

/**
 * Converts a dictionary of parameters into a Python dictionary string that can be inserted into the parameters cell.
 * E.g. { a: "1", b: "2" } -> "params = {"a": 1, "b": 2}"
 */
function createParameterCellText(params: NotebookParameters): string {
  // Create Python dictionary entries
  const entries: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    // Try to determine if value is numeric or boolean to avoid unnecessary quotes
    let formattedValue: string;
    if (value === 'true' || value === 'false') {
      // Convert JavaScript boolean strings to Python booleans
      formattedValue = value === 'true' ? 'True' : 'False';
    } else if (!isNaN(Number(value)) && value.trim() !== '') {
      // It's a valid number, use as is without quotes
      formattedValue = value;
    } else {
      // It's a string, add quotes
      formattedValue = `"${value.replace(/"/g, '\\"')}"`;
    }
    entries.push(`"${key}": ${formattedValue}`);
  }

  // Create a Python dictionary
  return `params = {${entries.join(', ')}}`;
}

/**
 * Inserts parameters into the notebook's PARAMETERS_MARKER cell (if found).
 * Returns the full parameter dictionary.
 */
function fillParametersFromUrl(notebookContent: Notebook): NotebookParameters {
  if (!notebookContent.model) {
    return {};
  }

  // 1. Get the full set of searchParams
  const searchParams = getAllPossibleParams();
  if (searchParams.size === 0) {
    console.log('notebookparams: no parameters found in any source');
    return {};
  }

  // 2. Build a dictionary of all parameters
  const params = buildParamsFromSearchParams(searchParams);

  // 3. Find the cell with PARAMETERS_MARKER and insert the parameter text
  const parameterCellText = createParameterCellText(params);
  if (parameterCellText) {
    const cells = notebookContent.model.cells;
    for (let i = 0; i < cells.length; i++) {
      const sharedModel = cells.get(i).sharedModel;
      if (sharedModel.source.startsWith(PARAMETERS_MARKER)) {
        sharedModel.setSource(`${PARAMETERS_MARKER}\n${parameterCellText}`);
        console.log(`notebookparams: parameters set in cell ${i}`);
        break;
      }
    }
  }

  return params;
}

/**
 * Executes all cells in the notebook (top to bottom).
 * If needed, you can adjust the logic to run only cells from the active cell downwards.
 */
function runAllCells(
  notebook: Notebook,
  sessionContext?: ISessionContext,
  sessionDialogs?: ISessionContextDialogs,
  translator?: ITranslator
): Promise<boolean> {
  if (!notebook.model) {
    return Promise.resolve(false);
  }
  return NotebookActions.runAll(notebook, sessionContext, sessionDialogs, translator);
}

/**
 * Executes all cells if 'autorun' in parameters is set to 'true', waiting for the kernel to be idle.
 */
function handleAutorun(params: NotebookParameters, notebook: Notebook, sessionContext: ISessionContext): void {
  // Check if autorun is enabled
  if (!params.autorun || params.autorun.toLowerCase() !== 'true') {
    return;
  }

  const kernelStatus = sessionContext.session?.kernel?.status;
  if (kernelStatus === 'idle') {
    runAllCells(notebook, sessionContext);
  } else {
    const onStatusChanged = () => {
      if (sessionContext.session?.kernel?.status === 'idle') {
        runAllCells(notebook, sessionContext);
        sessionContext.statusChanged.disconnect(onStatusChanged);
      }
    };
    sessionContext.statusChanged.connect(onStatusChanged);
  }
}

/**
 * The main function to process the notebook: insert parameters and (optionally) run.
 */
function processNotebook(notebookContent: Notebook, sessionContext: ISessionContext): void {
  const params = fillParametersFromUrl(notebookContent);
  // If 'autorun' is enabled, run the notebook
  handleAutorun(params, notebookContent, sessionContext);
}

/**
 * Sets up handlers for a specific notebook:
 * - When the notebook model is loaded
 * - When the session connection status changes
 */
function setupNotebookHandlers(
  notebook: { content: Notebook; context: { sessionContext: ISessionContext } } | null
): void {
  if (!notebook) {
    return;
  }

  const { content, context } = notebook;
  if (content.model) {
    processNotebook(content, context.sessionContext);
  }

  content.modelChanged.connect(() => processNotebook(content, context.sessionContext));
  context.sessionContext.connectionStatusChanged.connect(() =>
    processNotebook(content, context.sessionContext)
  );
}

/**
 * A JupyterLab plugin that automatically extracts parameters from the URL/referrer,
 * writes them to the cell with the "# Parameters:" marker,
 * and optionally runs all notebook cells if 'autorun' is set.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab-open-url-params-extension',
  autoStart: true,
  requires: [INotebookTracker],

  activate: (app: JupyterFrontEnd, tracker: INotebookTracker) => {
    // Listen for changes to the currently active notebook
    tracker.currentChanged.connect((_, notebook) => {
      setupNotebookHandlers(notebook);
    });
  }
};

export default plugin;