// cytoscape-cose-bilkent ships no type declarations — minimal shim (pass #108).
declare module "cytoscape-cose-bilkent" {
  const ext: import("cytoscape").Ext;
  export default ext;
}
