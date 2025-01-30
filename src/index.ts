import { JupyterFrontEnd, JupyterFrontEndPlugin } from '@jupyterlab/application';
import { ISessionContext, ISessionContextDialogs } from '@jupyterlab/apputils';
import { INotebookTracker, Notebook, NotebookActions } from '@jupyterlab/notebook';
import { ITranslator } from '@jupyterlab/translation';

// Function to run all cells below the current active cell
function runAllBelow(
  notebook: Notebook,
  sessionContext?: ISessionContext,
  sessionDialogs?: ISessionContextDialogs,
  translator?: ITranslator
): Promise<boolean> {
  if (!notebook.model || !notebook.activeCell) {
    return Promise.resolve(false);
  }

  const promise = NotebookActions.runCells(
    notebook,
    notebook.widgets,
    sessionContext,
    sessionDialogs,
    translator
  );

  return promise;
}

const plugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab-open-url-params-extension',
  autoStart: true,
  requires: [INotebookTracker],

  activate: (app: JupyterFrontEnd, tracker: INotebookTracker) => {
    tracker.currentChanged.connect((sender, notebook) => {
      const current = tracker.currentWidget;

      if (!current) return;

      const notebookContent = current.content;

      // Listen for connection status changes
      current.context.sessionContext.connectionStatusChanged.connect(
        (sender, notebook) => {
          const PARAMETERS_MARKER = '# Parameters:';
          let autorun = false;
          if (!notebookContent.model) return;
          for (let c = 0; c < notebookContent.model.cells.length; c++) {
            const searchParams = new URL(window.location.href).searchParams;
            let text = '';
            const sharedModel = notebookContent.model.cells.get(c).sharedModel;

            if (!sharedModel.source.startsWith(PARAMETERS_MARKER)) continue;

            searchParams.forEach((value, key) => {
              if (key === 'autorun') {
                autorun = value === 'true';
              } else if (key !== 'filepath') {
                text += `${key} = ${value}\n`;
              }
            });

            if (text) {
              sharedModel.setSource(`${PARAMETERS_MARKER}\n${text}`);
              console.log(`notebookparams: setting parameters in cell ${c}`);
            }
            break;
          }

          if (autorun && current) {
            runAllBelow(current.content, current.context.sessionContext);
          }
        }
      );
    });
  }
};

export default plugin;
