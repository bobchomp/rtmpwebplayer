`DejaVuSans.ttf` is used only to render the stacked bar chart in the Stats
page's "Export in Template" export (see `../statsTemplateExport.js`) -
loaded directly by `@resvg/resvg-js` rather than relying on any font being
installed on the server, since the production container (Alpine, no fonts
by default) has no other reliable way to draw chart text.

DejaVu Fonts are released under a free license (derived from the Bitstream
Vera license) that explicitly permits embedding and redistribution. Full
license text and source: https://dejavu-fonts.github.io/License.html
