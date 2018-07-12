// BUNDLED BY LASSO.
$_mod.def("/lasso-js-api$0.0.0/src/Greeter.ts", function (require, exports, module, __filename, __dirname) {
});
$_mod.def("/lasso-js-api$0.0.0/src/main", function (require, exports, module, __filename, __dirname) {
    var add = require('/lasso-js-api$0.0.0/src/add'/*'./add'*/);
    var jquery = require('/jquery$2.2.4/dist/jquery'/*'jquery'*/);
    var Greeter = require('/lasso-js-api$0.0.0/src/Greeter.ts'/*'./Greeter.ts'*/);

    jquery(function () {
        $(document.body).append('2+2=' + add(2, 2));
        //console.log(greeter);
        var greeter = new Greeter("Ajaykumar");
        $(document.body).append(greeter.greet());
    });

});

$_mod.installed("myebaynode$1.0.0", "jquery", "3.3.1");
$_mod.installed("@ebay/retriever$1.0.0", "lodash.get", "4.4.2");
$_mod.main("/highlnfe$16.4.2/src/components/utils/resize-listener", "");