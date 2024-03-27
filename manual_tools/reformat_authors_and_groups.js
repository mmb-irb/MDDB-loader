// This script was used to replace the old authors and groups format
// Strings were replaced by lists of strings

// Values were set by hand
const PARSED_AUTHORS = {
    "Vaibhav Modi": ["Vaibhav Modi"],
    "Giulia Paiardi, Stefan Richter, Marco Rusnati, Rebecca Wade": ["Giulia Paiardi", "Stefan Richter", "Marco Rusnati", "Rebecca Wade"],
    "Alexander Kuzmin, Philipp Orekhov, Roman Astashkin, Valentin Gordeliy, Ivan Gushchin": ["Alexander Kuzmin", "Philipp Orekhov", "Roman Astashkin", "Valentin Gordeliy", "Ivan Gushchin"],
    "Sarah Temmam, Khamsing Vongphayloth, Eduard Baquero, Sandie Munier, Massimiliano Bonomi": ["Sarah Temmam", "Khamsing Vongphayloth", "Eduard Baquero", "Sandie Munier", "Massimiliano Bonomi"],
    "Carlos A. Ramos-Guzmán, J. Javier Ruiz-Pernía, Iñaki Tuñón": ["Carlos A. Ramos-Guzmán", "J. Javier Ruiz-Pernía", "Iñaki Tuñón"],
    "Luc-Henri Jolly, CNRS/Sorbonne Université/IP2CT": ["Luc-Henri Jolly"],
    "Chia-en A. Chang, Yuliana Bosken, Timothy Cholko": ["Chia-en A. Chang", "Yuliana Bosken", "Timothy Cholko"],
    "Dmitry Morozov": ["Dmitry Morozov"],
    "Vito Genna": ["Vito Genna"],
    "Deborah K Shoemark": ["Deborah K Shoemark"],
    "Neha Vithani, Michael D Ward, Maxwell I. Zimmerman, Gregory R. Bowman": ["Neha Vithani", "Michael D Ward", "Maxwell I. Zimmerman", "Gregory R. Bowman"],
    "John D. Chodera": ["John D. Chodera"],
    "Y. Cao, Y.K. Choi, M. Frank, H. Woo, S.-J. Park, M.S. Yeom, C. Seok, and W. Im": ["Y. Cao", "Y.K. Choi", "M. Frank", "H. Woo", "S.-J. Park", "M.S. Yeom", "C. Seok", "W. Im"],
    "Maxwell Zimmerman": ["Maxwell I. Zimmerman"],
    "Gumbart lab": [],
    "Terra Sztain, Rommie Amaro, J. Andrew McCammon": ["Terra Sztain", "Rommie E. Amaro", "J. Andrew McCammon"],
    "Vito Genna, Matteo Castelli, Milosz Wieczor, Adam Hospital, Modesto Orozco": ["Vito Genna", "Matteo Castelli", "Miłosz Wieczór", "Adam Hospital", "Modesto Orozco"],
    "Logan Thrasher Collins, Tamer Elkholy, Shafat Mubin, David Hill, Ricky Williams, Kayode Ezike, and Ankush Singhal": ["Logan Thrasher Collins", "Tamer Elkholy", "Shafat Mubin", "David Hill", "Ricky Williams", "Kayode Ezike", "Ankush Singhal"],
    "Takaharu Mori, Jaewoon Jung, Chigusa Kobayashi, Hisham M. Dokainish, Suyong Re, Yuji Sugita": ["Takaharu Mori", "Jaewoon Jung", "Chigusa Kobayashi", "Hisham M. Dokainish", "Suyong Re", "Yuji Sugita"],
    "A.S.F. Oliveira": ["A.S.F. Oliveira"],
    "D. E. Shaw Research": ["D. E. Shaw Research"],
    "Halina Mikolajek, Miriam Weckener, Z. Faidon Brotzakis, Jiandong Huo, Evmorfia V Dalietou, Audrey Le Bas, Pietro Sormanni, Peter J Harrison, Philip N Ward, Steven Truong, Lucile Moynie, Daniel Clare, Maud Dumoux, Josh Dormon, Chelsea Norman, Naveed Hussain, Vinod Vogirala, Raymond J Owens, Michele Vendruscolo & James H Naismith": ["Halina Mikolajek", "Miriam Weckener", "Z. Faidon Brotzakis", "Jiandong Huo", "Evmorfia V Dalietou", "Audrey Le Bas", "Pietro Sormanni", "Peter J Harrison", "Philip N Ward", "Steven Truong", "Lucile Moynie", "Daniel Clare", "Maud Dumoux", "Josh Dormon", "Chelsea Norman", "Naveed Hussain", "Vinod Vogirala", "Raymond J Owens", "Michele Vendruscolo", "James H Naismith"],
    "Miłosz Wieczór, Tiziana Ginex": ["Miłosz Wieczór", "Tiziana Ginex"],
    "Mary Hongying Cheng": ["Mary Hongying Cheng"],
    "Terra Sztain†, Surl-Hee Ahn†, Anthony Bogetti, Jory A. Goldsmith, Lorenzo Casalino, Ryan McCool, Fiona Kearns, J. Andrew McCammon, Jason S. McLellan, Lillian Chong*, Rommie E. Amaro": ["Terra Sztain", "Surl-Hee Ahn", "Anthony Bogetti", "Jory A. Goldsmith", "Lorenzo Casalino", "Ryan McCool", "Fiona Kearns", "J. Andrew McCammon", "Jason S. McLellan", "Lillian Chong", "Rommie E. Amaro"],
    "Negin Forouzesh, Alexey Onufriev": ["Negin Forouzesh", "Alexey Onufriev"],
    "Lorenzo Casalino, Zied Gaieb, Abigail C. Dommer, Aoife M. Harbison, Carl A. Fogarty, Emilia P. Barros, Bryn C. Taylor, Elisa Fadda, Rommie E. Amaro": ["Lorenzo Casalino", "Zied Gaieb", "Abigail C. Dommer", "Aoife M. Harbison", "Carl A. Fogarty", "Emilia P. Barros", "Bryn C. Taylor", "Elisa Fadda", "Rommie E. Amaro"],
    "Juan Aranda": ["Juan Aranda"],
    "Miłosz Wieczór, Phu K. Tang, Modesto Orozco, Pilar Cossio":
        ["Miłosz Wieczór", "Phu K. Tang", "Modesto Orozco", "Pilar Cossio"],
    'Alessandro Coretti': ['Alessandro Coretti'],
    'Kazi Amirul Hossain': ['Kazi Amirul Hossain'],
    'Alberto Perez': ['Alberto Pérez'],
    'Pablo Dans': ['Pablo Dans'],
    "Tim Meyer ,\xa0Marco D'Abramo,\xa0Adam Hospital,\xa0Manuel Rueda,\xa0Carles Ferrer-Costa,\xa0Alberto Pérez,\xa0Oliver Carrillo,\xa0Jordi Camps,\xa0Carles Fenollosa,\xa0Dmitry Repchevsky,\xa0Josep Lluis Gelpí,\xa0Modesto Orozco":
        ['Tim Meyer', "Marco D'Abramo", 'Adam Hospital', 'Manuel Rueda', 'Carles Ferrer-Costa', 'Alberto Pérez', 'Oliver Carrillo', 'Jordi Camps', 'Carles Fenollosa', 'Dmitry Repchevsky', 'Josep Lluís Gelpí', 'Modesto Orozco'],
    'Isabel Martín': ['Isabel Martín'],
    'Rafal Wiewiora': ['Rafal Wiewiora'],
    'Sukrit Singh, David Schaller, Andrea Volkamer, John Chodera':
        ['Sukrit Singh', 'David Schaller', 'Andrea Volkamer', 'John D. Chodera'],
    'Thomas E. Cheatham': ['Thomas E. Cheatham'],
    'G. Portella': ['G. Portella'],
    'Jessica Rodriguez': ['Jessica Rodriguez'],
    'Ivan Ivani': ['Ivan Ivani'],
    'Luca Maggi': ['Luca Maggi'],
    'Giulia Paiardi, Matheus Ferraz, Marco Rusnati, Rebecca Wade':
        ['Giulia Paiardi', 'Matheus Ferraz', 'Marco Rusnati', 'Rebecca Wade'],
    'Adam Hospital': ['Adam Hospital'],
    'Ivy Zhang': ['Ivy Zhang'],
    'Marco Pasi & Charles Laughton': ['Marco Pasi', 'Charles Laughton'],
    'Jan Huertas': ['Jan Huertas'],
    'Alexandra Balaceanu': ['Alexandra Balaceanu'],
    'NBD, IRB and BSC': [],
    'Agnes / Pablo': ['Agnes Noy', 'Pablo Dans'],
    'Milosz Wieczor': ["Miłosz Wieczór"],
    'Alexandros Tsengenes, Christina Athanasiou, Rebecca Wade':
        ["Alexandros Tsengenes", "Christina Athanasiou", "Rebecca Wade"],
    'ABC': [],
    'Lluís Jordà': ['Lluís Jordà'],
    'Federica Battistini': ['Federica Battistini'],
    'Alessio Olivieri': ['Alessio Olivieri'],
    'Agnes Noy': ['Agnes Noy'],
    'Josep Lluis Gelpi': ['Josep Lluís Gelpí'],
    'Adam Hospital, Francesco Colizzi, Daniel Beltrán':
        ['Adam Hospital', 'Francesco Colizzi', 'Daniel Beltrán'],
    'Thomas C. Bishop': ['Thomas C. Bishop'],
    'Ignacio Faustino': ['Ignacio Faustino'],
    'Rommie E. Amaro et al.': ['Rommie E. Amaro'],
    'Athina Meletiou': ['Athina Meletiou'],
    'Nicholas H. Moeller, Ke Shi, Özlem Demir, Christopher Belica, Surajit Banerjee, Lulu Yin, Cameron Durfee, Rommie E. Amaro and Hideki Aihara':
        ['Nicholas H. Moeller', 'Ke Shi', 'Özlem Demir', 'Christopher Belica', 'Surajit Banerjee',
         'Lulu Yin', 'Cameron Durfee', 'Rommie E. Amaro', 'Hideki Aihara']
}

const PARSED_GROUPS = {
    "Piquemal Group": ["Sorbonne Université, Piquemal group"],
    "University of Jyvaskyla": ["University of Jyväskylä"],
    "Amaro Lab and Chong Lab": ["University of California, Amaro lab", "University of Pittsburgh, Chong lab"],
    "RIKEN CPR (Cluster for Pioneering Research), TMS (Theoretical molecular science) laboratory": [
        "RIKEN, TMS laboratory"],
    "D. E. Shaw Research (DESRES)": ["D. E. Shaw Research (DESRES)"],
    "Research Center for Molecular Mechanisms of Aging and Age-related Diseases -- Valentin Gordeliy’s Lab, Ivan Gushchin’s Lab": [
        "MIPT, Valentin Gordeliy lab", "MIPT, Ivan Gushchin lab"],
    "Orozco Lab, IRB Barcelona & Centro de Investigaciones Biológicas Margarita Salas (CIB-CSIC)": [
        "IRB Barcelona, Orozco lab", "CIB-CSIC"],
    "University of Bristol, UK -- BrisSynBio and Mulholland": [
        "University of Bristol, BrisSynBio", "University of Bristol, Mulholland lab"],
    "DESRES": ["D. E. Shaw Research (DESRES)"],
    "University of Pittsburgh -- Bahar lab": ["University of Pittsburgh, Bahar lab"],
    "Chodera lab": ["Sloan Kettering Institute, Chodera lab"],
    "Vendruscolo group, Naismith group, Owens group": [
        "University of Cambridge, Vendruscolo group",
        "University of St. Andrews, Naismith group",
        "Columbia University, Owens group"],
    "Universidad de Valencia -- Efectos del medio": ["Universidad de Valencia, Efectos del medio"],
    "Gumbart lab": ["Georgia Institute of Technology, Gumbart lab"],
    "Molecular and Cellular Modeling Group, Heidelberg Institute for Theoretical Studies (HITS), Heidelberg, Germany. Experimental Oncology and Immunology, Department of Molecular and Translational Medicine, University of Brescia, Brescia, Italy.": [
        "Heidelberg Institute for Theoretical Studies, MCM", "University of Brescia, DMMT"],
    "Orozco Lab, IRB Barcelona; Cossio Lab, Flatiron Institute": [
        "IRB Barcelona, Orozco lab", "Flatiron Institute, Cossio lab"],
    "University of Jyväskylä": ["University of Jyväskylä"],
    "Gregory R. Bowman (Bowman lab)": ["University of Pennsylvania, Bowman lab"],
    "Orozco Lab, IRB Barcelona": ["IRB Barcelona, Orozco lab"],
    "Amaro Lab and McCammon Lab": ["University of California, Amaro lab", "University of California, McCammon lab"],
    "Conduit Computing": ["Conduit Computing"],
    "Amaro Lab": ["University of California, Amaro lab"],
    "University of Bristol -- Mulholland Lab": ["University of Bristol, Mulholland lab"],
    "CHARMM-GUI Team": ["CHARMM-GUI Team"],
    "California State University, Los Angeles and Virginia Tech": ["California State University", "Virginia Tech"],
    "Chang group, University of California, Riverside": ["University of California, Chang group"],
    "Orozco Lab": ["IRB Barcelona, Orozco lab"],
    "Institut Pasteur, Université de Paris, CNRS UMR 3528, Structural Bioinformatics Unit, Paris, France": [
        "Institut Pasteur, Structural Bioinformatics Unit"],
    "": [],
    "None": [],
    None: [],
    "Molecular and Cellular Modeling Group, Heidelberg Institute for Theoretical Studies (HITS), Heidelberg, Germany":
        ['Heidelberg Institute for Theoretical Studies'],
    "(1) Molecular and Cellular Modeling Group, Heidelberg Institute for Theoretical Studies (HITS), Heidelberg, Germany. (2) Experimental Oncology and Immunology, Department of Molecular and Translational Medicine, University of Brescia, Brescia, Italy.":
        ["Heidelberg Institute for Theoretical Studies", "University of Brescia, DMMT"],
    "Orozco lab, IRB Barcelona": ["IRB Barcelona, Orozco lab"],
    "BSC": ["Barcelona Supercomputing Center"],
    "ABC": ["Ascona B-DNA Consortium"],
    "Cheatham lab": ["University of Utah, Cheatham lab"],
    "Thomas C. Bishop's Lab": ["Louisiana Tech University, Bishop Lab"],
    'Department of Cellular and Developmental Biology, Max Planck Institute for Molecular Biomedicine, Münster, Germany':
        ['Heidelberg Institute for Theoretical Studies'],
    'Orozco lab, Guallar lab':
        ["IRB Barcelona, Orozco lab", "Barcelona Supercomputing Center, Guallar lab", "Nostrum Biodiscovery"]
}

// Read the '.env' configuration file
const dotenvLoad = require('dotenv').config({ path: __dirname + '/../.env' });
if (dotenvLoad.error) throw dotenvLoad.error;

const getDatabase = require('../src/database');
const { idOrAccessionCoerce } = require('../src/utils/auxiliar-functions');

// -------------------------------------------------------------------------------------------------
// -------------------------------------------------------------------------------------------------

// Parse the script arguments to ids or accesions
const projectIdsOrAccessions = [];
process.argv.forEach((arg, i) => {
  // Skip the first 2 arguments: the path to the command and the path to the script
  if (i < 2) return;
  // Parse the argument to an id or accesion
  // If it fails then it will throw an error
  const idOrAccesion = idOrAccessionCoerce(arg);
  projectIdsOrAccessions.push(idOrAccesion);
});

// The main function
// This is an async wrapper to be able to call await
const main = async () => {
  // Warn the user about what it about to happen
  if (projectIdsOrAccessions.length === 0)
    return console.log('No projects were passed');
  if (projectIdsOrAccessions.length === 1)
    console.log('Updating project ' + projectIdsOrAccessions[0]);
  else return console.log('There must be 1 project only');

  const idOrAccession = projectIdsOrAccessions[0];

  // Set the database handler
  const database = await getDatabase();
  // Sync the requested project
  const project = await database.syncProject(id = idOrAccession);
  console.log('   Project ID: ' + project.id);

  // Replace old author by the new ones
  const oldAuthors = project.data.metadata.AUTHORS;
  if (typeof oldAuthors === 'string') {
    console.log('   Reformating authors')
    const newAuthors = PARSED_AUTHORS[oldAuthors];
    project.data.metadata.AUTHORS = newAuthors;
    await project.updateRemote();
  }
  // Replace old groups by the new ones
  const oldGroups = project.data.metadata.GROUPS;
  if (typeof oldGroups === 'string') {
    console.log('   Reformating groups')
    const newGroups = PARSED_GROUPS[oldGroups];
    project.data.metadata.GROUPS = newGroups;
    await project.updateRemote();
  }
  // Clean exit
  console.log('Allright :)');
  process.exit(0);
};

main();
