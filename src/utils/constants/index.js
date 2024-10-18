// Export some constants used along the whole code

module.exports = {
    // Expected filename patterns
    // Set files to be found in the project directory
    EXPECTED_PROJECT_FILE: {
        // Metadata file, one for project
        metadataFile: {
            pattern: /^metadata.json$/i,
            singleFile: true,
        },
        // Topology files, one for project
        topologyFile: {
            pattern: /^topology.(prmtop|top|psf|tpr)$/i,
            singleFile: true,
        },
        // Charges files, any number for project (for .top topologies only)
        itpFiles: {
            pattern: /\.(itp)$/i,
        },
        // The topology data file, one for project
        topologyDataFile: {
            pattern: /^topology.json$/i,
            singleFile: true,
        },
        // The references data file, one for project
        referencesDataFile: {
            pattern: /^references.json$/i,
            singleFile: true,
        },
        // Inputs file, which is not to be loaded but simply readed
        ligandsDataFile: {
        pattern: /^ligands.json$/i,
        singleFile: true,
        },
        // The populations data file, one for project
        populationsDataFile: {
            pattern: /^populations.json$/i,
            singleFile: true,
        },
        // Additional files to load, any number
        uploadableFiles: {
            pattern: /^mdf./i,
        },
        // Inputs file, which is not to be loaded but simply readed
        inputsFile: {
            pattern: /^inputs.(yaml|yml|json)$/i,
            singleFile: true,
        }
    },
    // Set files to be found in the MD directory
    EXPECTED_MD_FILES: {
        // Metadata file, one for project
        metadataFile: {
            pattern: /metadata.json$/i,
            singleFile: true,
        },
        // Structure file, one for every MD directory
        structureFile: {
            pattern: /^structure.pdb$/i,
            singleFile: true,
        },
        // The main trajectory, one for every MD directory
        mainTrajectory: {
            pattern: /^trajectory.xtc$/i,
            singleFile: true,
        },
        // Analyses, any number for every MD directory
        analysisFiles: {
            pattern: /^mda.[\s\S]*.(json)$/i,
        },
        // Additional files to load, any number
        uploadableFiles: {
            pattern: /^mdf./i,
        },
        // Additional trajectory files to parse-load, any number for every MD directory
        uploadableTrajectories: {
            pattern: /^mdt.[\s\S]*.xtc/i,
        }
    },
    // These are just URLs to access web pages with useful alaytical tools
    interProScanURL: 'https://www.ebi.ac.uk/Tools/services/rest/iprscan5',
    hmmerURL: 'https://www.ebi.ac.uk/Tools/hmmer/',
  };
  